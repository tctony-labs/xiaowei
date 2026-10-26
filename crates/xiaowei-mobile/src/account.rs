use prost::Message;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio_util::sync::CancellationToken;
use xw_api::account::{Access, Operation, SessionCore};

use crate::{LocalErrorKind, MobileError, Result, SessionContext, runtime};

#[derive(Clone, Debug)]
pub struct AccountOutcome {
    pub code: i32,
    pub msg: String,
    pub authenticated: Option<Vec<u8>>,
    pub credential_version: u64,
    pub checkpoint: bool,
    pub next_maintenance_at_ms: i64,
}

impl From<xw_api::account::Outcome> for AccountOutcome {
    fn from(value: xw_api::account::Outcome) -> Self {
        Self {
            code: value.code,
            msg: value.message,
            authenticated: value
                .session
                .map(|session| session.authenticated.encode_to_vec()),
            credential_version: value.credential_version,
            checkpoint: value.checkpoint,
            next_maintenance_at_ms: value.next_maintenance_at_ms,
        }
    }
}

struct State {
    closed: bool,
    task: Option<runtime::Task<AccountOutcome>>,
    closing: Option<runtime::Task<()>>,
}

pub struct AccountOperation {
    pub(crate) work: Arc<AccountWork>,
}

pub(crate) struct AccountWork {
    id: String,
    identity: (String, String, String),
    core: Arc<SessionCore>,
    command: Operation,
    cancel: CancellationToken,
    state: Mutex<State>,
    released: Arc<AtomicBool>,
}

impl AccountOperation {
    pub(crate) fn new(
        api: Arc<xw_api::Client>,
        context: &SessionContext,
        command: Operation,
        cancel: CancellationToken,
    ) -> Result<Arc<Self>> {
        let (server, session) = context.decode()?;
        let core = SessionCore::new(api);
        let _runtime = runtime::get()?.enter();
        core.activate(server, session, context.connect, xw_api::now_ms());
        Ok(Arc::new(Self {
            work: Arc::new(AccountWork {
                id: uuid::Uuid::new_v4().to_string(),
                identity: context.identity()?,
                core,
                command,
                cancel,
                state: Mutex::new(State {
                    closed: false,
                    task: None,
                    closing: None,
                }),
                released: Arc::new(AtomicBool::new(false)),
            }),
        }))
    }

    pub async fn run(&self) -> Result<AccountOutcome> {
        self.work.run().await
    }

    pub async fn resume(&self, credential_version: u64) -> Result<AccountOutcome> {
        self.work.resume(credential_version).await
    }

    pub fn cancel(&self) {
        self.work.cancel();
    }

    pub async fn settled_result(&self) -> Result<AccountOutcome> {
        self.work.settled_result().await
    }

    pub async fn close(&self) -> Result<()> {
        self.work.close().await
    }
}

impl AccountWork {
    pub(crate) fn identity(&self) -> &(String, String, String) {
        &self.identity
    }

    async fn run(&self) -> Result<AccountOutcome> {
        let task = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(MobileError::closed());
            }
            if state.task.is_none() {
                let core = self.core.clone();
                let id = self.id.clone();
                let command = self.command.clone();
                let cancel = self.cancel.clone();
                log::debug!("Mobile account operation started id={id}");
                state.task = Some(runtime::spawn(async move {
                    let result = core
                        .start(
                            id.clone(),
                            command,
                            xw_api::now_ms(),
                            Access::default(),
                            cancel,
                        )
                        .await;
                    log::debug!(
                        "Mobile account operation returned id={} code={} checkpoint={}",
                        id,
                        result.code,
                        result.checkpoint
                    );
                    Ok(result.into())
                })?);
            }
            state.task.clone().unwrap()
        };
        task.await
    }

    async fn resume(&self, version: u64) -> Result<AccountOutcome> {
        let task = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(MobileError::closed());
            }
            let outcome = state
                .task
                .as_ref()
                .and_then(|task| task.peek())
                .ok_or_else(|| {
                    MobileError::local(LocalErrorKind::InvalidState, "账号操作尚未返回检查点")
                })?
                .as_ref()
                .map_err(Clone::clone)?;
            if !outcome.checkpoint || outcome.credential_version != version {
                return Err(MobileError::local(
                    LocalErrorKind::InvalidState,
                    "账号操作检查点或凭据版本不匹配",
                ));
            }
            let core = self.core.clone();
            let id = self.id.clone();
            let cancel = self.cancel.clone();
            let task = runtime::spawn(async move {
                Ok(core.resume(&id, xw_api::now_ms(), cancel).await.into())
            })?;
            state.task = Some(task.clone());
            task
        };
        task.await
    }

    pub(crate) fn cancel(&self) {
        self.cancel.cancel();
        self.core.cancel(&self.id);
    }

    async fn settled_result(&self) -> Result<AccountOutcome> {
        let task = self.state.lock().unwrap().task.clone();
        if let Some(task) = task {
            // Waiting is independent of a foreign task's lifetime. The core retains rotations.
            let _ = task.await;
        } else {
            if !self.cancel.is_cancelled() {
                return Err(MobileError::local(
                    LocalErrorKind::InvalidState,
                    "账号操作尚未执行",
                ));
            }
            let mut outcome = AccountOutcome::from(self.core.outcome(xw_api::now_ms()));
            let error = xw_api::Error::cancelled();
            outcome.code = error.code;
            outcome.msg = error.message;
            return Ok(outcome);
        }
        let core = self.core.clone();
        runtime::spawn(async move { Ok(core.settled_outcome(xw_api::now_ms()).await.into()) })?
            .await
    }

    pub(crate) async fn close(&self) -> Result<()> {
        let task = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            self.cancel();
            if state.closing.is_none() {
                let running = state.task.clone();
                let core = self.core.clone();
                let released = self.released.clone();
                state.closing = Some(runtime::spawn(async move {
                    if let Some(running) = running {
                        let _ = running.await;
                    }
                    core.settled_outcome(xw_api::now_ms()).await;
                    core.close().await;
                    released.store(true, Ordering::Release);
                    Ok(())
                })?);
            }
            state.closing.clone().unwrap()
        };
        task.await
    }

    pub(crate) fn released(&self) -> bool {
        self.released.load(Ordering::Acquire)
    }
}

impl Drop for AccountOperation {
    fn drop(&mut self) {
        self.cancel();
    }
}
