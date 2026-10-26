//! One authenticated connection for the host's committed session.
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::{Target, normalize_server, websocket::Peer, wire::Route};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authentication {
    Authenticated,
    Rejected,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub generation: u64,
    pub status: Status,
    pub authentication: Option<Authentication>,
}

struct State {
    target: Target,
    key: String,
    generation: u64,
    peer: Option<Arc<Peer>>,
    cancellation: CancellationToken,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    closed: bool,
}

pub struct Connection {
    state: Mutex<State>,
    updates: watch::Sender<Snapshot>,
    closing: tokio::sync::Mutex<()>,
}

fn session_key(target: &Target, now_ms: i64) -> String {
    let Some(session) = &target.session else {
        return String::new();
    };
    if session.server != target.server
        || session.session_id.is_empty()
        || session.access_token.is_empty()
        || session.access_expires_at_ms <= now_ms
    {
        return String::new();
    }
    serde_json::to_string(&(&session.server, &session.session_id, &session.access_token)).unwrap()
}

impl Connection {
    pub fn new() -> Arc<Self> {
        let (updates, _) = watch::channel(Snapshot {
            generation: 0,
            status: Status::Disconnected,
            authentication: Some(Authentication::Unavailable),
        });
        Arc::new(Self {
            state: Mutex::new(State {
                target: Target::default(),
                key: String::new(),
                generation: 0,
                peer: None,
                cancellation: CancellationToken::new(),
                tasks: Vec::new(),
                closed: false,
            }),
            updates,
            closing: tokio::sync::Mutex::new(()),
        })
    }

    pub fn subscribe(&self) -> watch::Receiver<Snapshot> {
        self.updates.subscribe()
    }

    pub fn set_target(self: &Arc<Self>, target: Target, now_ms: i64) -> u64 {
        let mut state = self.state.lock().unwrap();
        let key = session_key(&target, now_ms);
        if state.closed || key == state.key {
            return state.generation;
        }
        state.generation += 1;
        state.cancellation.cancel();
        if let Some(peer) = state.peer.take() {
            peer.close();
        }
        state.key = key;
        state.target = target.clone();
        state.cancellation = CancellationToken::new();
        state.tasks.retain(|task| !task.is_finished());
        let generation = state.generation;
        self.updates.send_replace(Snapshot {
            generation,
            status: if state.key.is_empty() {
                Status::Disconnected
            } else {
                Status::Connecting
            },
            authentication: if state.key.is_empty() {
                Some(Authentication::Unavailable)
            } else {
                None
            },
        });
        if !state.key.is_empty() {
            let weak = Arc::downgrade(self);
            let cancel = state.cancellation.clone();
            state.tasks.push(tokio::spawn(async move {
                Self::maintain(weak, target, generation, cancel).await;
            }));
        }
        generation
    }

    fn publish(
        &self,
        generation: u64,
        status: Status,
        auth: Authentication,
        peer: Option<Arc<Peer>>,
    ) {
        let mut state = self.state.lock().unwrap();
        if state.closed || state.generation != generation {
            return;
        }
        state.peer = peer;
        self.updates.send_replace(Snapshot {
            generation,
            status,
            authentication: Some(auth),
        });
    }

    async fn maintain(
        weak: std::sync::Weak<Self>,
        target: Target,
        generation: u64,
        cancel: CancellationToken,
    ) {
        let Some(session) = &target.session else {
            return;
        };
        let Ok(server) = normalize_server(&target.server) else {
            return;
        };
        let Ok(mut url) = url::Url::parse(&format!("{server}/api/ws")) else {
            return;
        };
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        let _ = url.set_scheme(scheme);
        let mut failures: u32 = 0;
        loop {
            if cancel.is_cancelled() {
                return;
            }
            if let Some(connection) = weak.upgrade() {
                let state = connection.state.lock().unwrap();
                if state.closed || state.generation != generation {
                    return;
                }
                connection.updates.send_replace(Snapshot {
                    generation,
                    status: if failures == 0 {
                        Status::Connecting
                    } else {
                        Status::Reconnecting
                    },
                    authentication: None,
                });
            } else {
                return;
            }
            let connected =
                Peer::connect(url.as_str(), &session.access_token, cancel.clone()).await;
            if cancel.is_cancelled() {
                return;
            }
            let reason = match connected {
                Ok(peer) => {
                    let Some(connection) = weak.upgrade() else {
                        return;
                    };
                    connection.publish(
                        generation,
                        Status::Connected,
                        Authentication::Authenticated,
                        Some(peer.clone()),
                    );
                    drop(connection);
                    log::info!("Server WebSocket connected generation={generation}");
                    failures = 0;
                    let reason = loop {
                        tokio::select! {
                            biased;
                            _ = cancel.cancelled() => { peer.close(); return; }
                            reason = peer.closed() => break reason,
                            _ = tokio::time::sleep(std::time::Duration::from_secs(15)) => {
                                if crate::now_ms() >= session.access_expires_at_ms {
                                    peer.close();
                                    break crate::wire::WireError::unavailable();
                                }
                                let result = tokio::select! {
                                    _ = cancel.cancelled() => { peer.close(); return; }
                                    result = peer.ping() => result,
                                };
                                if result.is_err() { peer.close(); }
                            }
                        }
                    };
                    reason
                }
                Err(reason) => reason,
            };
            let Some(connection) = weak.upgrade() else {
                return;
            };
            if reason.code == "UNAUTHORIZED" {
                connection.publish(
                    generation,
                    Status::Disconnected,
                    Authentication::Rejected,
                    None,
                );
                log::warn!("Server WebSocket authentication rejected generation={generation}");
                return;
            }
            connection.publish(
                generation,
                Status::Reconnecting,
                Authentication::Unavailable,
                None,
            );
            drop(connection);
            failures = failures.saturating_add(1);
            let wait_ms = (500_u64 << failures.saturating_sub(1).min(6)).min(30_000);
            // Per-attempt jitter prevents all devices reconnecting in lockstep.
            let jitter = (uuid::Uuid::new_v4().as_u128() as u64) % ((wait_ms / 4).min(1000) + 1);
            log::warn!("Server WebSocket disconnected generation={generation} retry_ms={wait_ms}");
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tokio::time::sleep(std::time::Duration::from_millis(wait_ms + jitter)) => {}
            }
        }
    }

    pub async fn authenticate(&self, cancel: CancellationToken) -> crate::Result<Authentication> {
        let mut updates = self.subscribe();
        let generation = updates.borrow().generation;
        loop {
            if cancel.is_cancelled() {
                return Err(crate::Error::cancelled());
            }
            let snapshot = updates.borrow_and_update().clone();
            if snapshot.generation != generation {
                return Ok(Authentication::Unavailable);
            }
            if let Some(auth) = snapshot.authentication {
                if auth == Authentication::Authenticated
                    && self.state.lock().unwrap().peer.is_none()
                {
                    return Ok(Authentication::Unavailable);
                }
                return Ok(auth);
            }
            tokio::select! {
                _ = cancel.cancelled() => return Err(crate::Error::cancelled()),
                result = updates.changed() => {
                    if result.is_err() { return Ok(Authentication::Unavailable); }
                }
            }
        }
    }

    pub fn can_invoke(&self, route: &Route, target: &Target) -> bool {
        self.peer(route, target).is_some()
    }

    pub fn peer(&self, route: &Route, target: &Target) -> Option<Arc<Peer>> {
        let state = self.state.lock().unwrap();
        if state.closed || state.key.is_empty() || session_key(target, crate::now_ms()) != state.key
        {
            return None;
        }
        state
            .peer
            .as_ref()
            .filter(|peer| peer.can_invoke(route))
            .cloned()
    }

    pub async fn close(&self) {
        let _closing = self.closing.lock().await;
        let tasks = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.closed = true;
            state.cancellation.cancel();
            if let Some(peer) = state.peer.take() {
                peer.close();
            }
            self.updates.send_replace(Snapshot {
                generation: state.generation,
                status: Status::Disconnected,
                authentication: Some(Authentication::Unavailable),
            });
            std::mem::take(&mut state.tasks)
        };
        for task in tasks {
            let _ = task.await;
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        let state = self.state.get_mut().unwrap();
        state.cancellation.cancel();
        if let Some(peer) = state.peer.take() {
            peer.close();
        }
    }
}
