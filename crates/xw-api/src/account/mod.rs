//! Single-server authentication and session maintenance. No persistence or storage interface.
mod refresh;
mod session;
mod types;

pub use self::types::{Access, Operation, Outcome, Session};
use self::types::{Next, Phase};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

struct Pending {
    id: String,
    phase: Phase,
    access: Access,
    cancel: CancellationToken,
    generation: u64,
}

struct State {
    server: String,
    session: Option<Session>,
    generation: u64,
    version: u64,
    connect: bool,
    suspended: bool,
    closed: bool,
    pending: Option<Pending>,
    last_error: Option<crate::Error>,
}

pub struct SessionCore {
    api: Arc<crate::Client>,
    state: Mutex<State>,
    gate: tokio::sync::Mutex<()>,
}

impl SessionCore {
    pub fn new(api: Arc<crate::Client>) -> Arc<Self> {
        Arc::new(Self {
            api,
            gate: tokio::sync::Mutex::new(()),
            state: Mutex::new(State {
                server: String::new(),
                session: None,
                generation: 0,
                version: 0,
                connect: false,
                suspended: false,
                closed: false,
                pending: None,
                last_error: None,
            }),
        })
    }

    /// Host supplies its own committed state. A target change invalidates all older work.
    /// `connect = false` permits an isolated inactive/uncommitted session operation.
    pub fn activate(&self, server: String, session: Option<Session>, connect: bool, now_ms: i64) {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return;
        }
        if let Some(pending) = state.pending.take() {
            pending.cancel.cancel();
        }
        state.generation += 1;
        state.version += 1;
        state.server = server;
        state.session = session;
        state.connect = connect;
        state.suspended = false;
        state.last_error = None;
        if connect {
            self.api.connection.set_target(Self::target(&state), now_ms);
        }
    }

    pub fn suspend(&self) {
        let mut state = self.state.lock().unwrap();
        state.suspended = true;
        state.generation += 1;
        if let Some(pending) = &state.pending {
            pending.cancel.cancel();
        }
        if state.connect {
            self.api
                .connection
                .set_target(crate::Target::default(), crate::now_ms());
        }
    }

    pub fn cancel(&self, id: &str) {
        if let Some(pending) = &self.state.lock().unwrap().pending {
            if pending.id == id {
                pending.cancel.cancel();
            }
        }
    }

    pub fn outcome(&self, now_ms: i64) -> Outcome {
        let state = self.state.lock().unwrap();
        Self::result(&state, now_ms)
    }

    pub async fn settled_outcome(&self, now_ms: i64) -> Outcome {
        let _gate = self.gate.lock().await;
        self.outcome(now_ms)
    }

    fn result(state: &State, now_ms: i64) -> Outcome {
        let error = state.last_error.as_ref();
        Outcome {
            code: error.map_or(0, |error| error.code),
            message: error.map_or_else(String::new, |error| error.message.clone()),
            session: state.session.clone(),
            credential_version: state.version,
            checkpoint: state
                .pending
                .as_ref()
                .is_some_and(|p| !matches!(p.phase, Phase::Complete))
                && error.is_none(),
            next_maintenance_at_ms: state
                .session
                .as_ref()
                .and_then(|session| session.authenticated.tokens.as_ref())
                .map_or(now_ms + 30_000, |tokens| {
                    tokens.access_expires_at_ms - refresh::LEAD_MS
                }),
        }
    }

    pub async fn start(
        &self,
        id: String,
        operation: Operation,
        now_ms: i64,
        access: Access,
        cancel: CancellationToken,
    ) -> Outcome {
        let observed = self.state.lock().unwrap().version;
        let _gate = self.gate.lock().await;
        {
            let mut state = self.state.lock().unwrap();
            if state.closed || state.suspended {
                return Self::failure(
                    &mut state,
                    crate::Error::unavailable("会话服务已暂停或关闭"),
                    now_ms,
                );
            }
            if state
                .pending
                .as_ref()
                .is_some_and(|p| !matches!(p.phase, Phase::Complete))
            {
                let mut result = Self::result(&state, now_ms);
                result.code = 10008;
                result.message = "会话操作正在等待宿主确认".into();
                return result;
            }
            // Concurrent maintenance sees the rotated in-memory pair instead of reusing a token.
            let already_rotated = state.version != observed;
            let phase = match operation {
                Operation::Login(request) => Phase::Login(request),
                Operation::Maintain { force } => Phase::Fresh {
                    force: force && !already_rotated,
                    next: Next::Complete,
                },
                Operation::Restore { force } => Phase::Fresh {
                    force: force && !already_rotated,
                    next: Next::Validate {
                        confirm_rejection: force,
                    },
                },
                Operation::Logout => Phase::Fresh {
                    force: false,
                    next: Next::Logout { retried: false },
                },
                Operation::Revoke => Phase::Revoke,
            };
            state.pending = Some(Pending {
                id,
                phase,
                access,
                cancel,
                generation: state.generation,
            });
            state.last_error = None;
        }
        self.drive(now_ms).await
    }

    /// Continue only after the embedding application has accepted a credential checkpoint.
    /// This acknowledgement has no storage semantics; the core never performs or supplies I/O.
    pub async fn resume(&self, id: &str, now_ms: i64, cancel: CancellationToken) -> Outcome {
        let _gate = self.gate.lock().await;
        {
            let mut state = self.state.lock().unwrap();
            let generation = state.generation;
            let Some(pending) = &mut state.pending else {
                return Self::failure(&mut state, crate::Error::invalid("会话操作不存在"), now_ms);
            };
            if pending.id != id || pending.generation != generation || pending.cancel.is_cancelled()
            {
                return Self::failure(&mut state, crate::Error::cancelled(), now_ms);
            }
            pending.cancel = cancel;
            state.last_error = None;
        }
        self.drive(now_ms).await
    }

    fn failure(state: &mut State, error: crate::Error, now_ms: i64) -> Outcome {
        if let Some(pending) = &mut state.pending {
            pending.phase = Phase::Complete;
        }
        state.last_error = Some(error);
        Self::result(state, now_ms)
    }

    pub async fn close(&self) {
        {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            state.suspended = true;
            state.generation += 1;
            if let Some(pending) = &state.pending {
                pending.cancel.cancel();
            }
            if state.connect {
                self.api
                    .connection
                    .set_target(crate::Target::default(), crate::now_ms());
            }
        }
        let _gate = self.gate.lock().await;
    }
}

impl Drop for SessionCore {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap();
        if let Some(pending) = &state.pending {
            pending.cancel.cancel();
        }
    }
}
