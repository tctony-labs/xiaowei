use super::{Context, Control, Endpoint, argument, parse, unavailable};
use crate::protocol::{CONTROL_VERSION, WireResult};
use crate::stream::{self, StreamHandle};
use crate::{ErrorCode, GatewayError, Route};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamControl {
    pub version: u32,
    pub operation: String,
    pub stream_id: String,
    pub route: Option<Route>,
}
pub(super) struct Session {
    token: String,
    cancel: watch::Sender<bool>,
    handle: Option<StreamHandle>,
    sequence: u32,
}
#[derive(Default)]
pub(super) struct Sessions(pub Mutex<HashMap<String, Session>>);
impl Sessions {
    pub fn close(&self) {
        for (_, session) in self.0.lock().unwrap().drain() {
            session.cancel.send_replace(true);
            if let Some(handle) = session.handle {
                handle.cancel_now();
            }
        }
    }
}
impl Endpoint {
    /// Called synchronously on the JS thread before spawning open, so cancel cannot overtake registration.
    pub fn prepare_stream(&self, metadata: &str, context: &str) -> Result<(), GatewayError> {
        self.ready()?;
        let control: StreamControl = parse(metadata)?;
        let context: Context = parse(context)?;
        if control.version != CONTROL_VERSION {
            return Err(GatewayError::new(ErrorCode::Incompatible, "stream version"));
        }
        if control.stream_id.is_empty() || control.stream_id.len() > 200 {
            return Err(argument());
        }
        if control.operation == "stream.open" {
            let route = control.route.as_ref().ok_or_else(argument)?;
            route.validate()?;
            context.core().authorize(&route.name, false)?;
            let mut sessions = self.streams.0.lock().unwrap();
            if sessions.contains_key(&control.stream_id) {
                return Err(argument());
            }
            if sessions.len() >= 128 {
                return Err(GatewayError::new(ErrorCode::ResourceExhausted, "endpoint streams full"));
            }
            sessions.insert(
                control.stream_id,
                Session {
                    token: context.token,
                    cancel: watch::channel(false).0,
                    handle: None,
                    sequence: 0,
                },
            );
        }
        Ok(())
    }
    pub async fn stream_control(self: &Arc<Self>, metadata: &str, payload: Vec<u8>, context: &str) -> WireResult {
        self.ready()?;
        let control: StreamControl = parse(metadata)?;
        let context: Context = parse(context)?;
        if control.version != CONTROL_VERSION {
            return Err(GatewayError::new(ErrorCode::Incompatible, "stream version"));
        }
        let (cancel, handle, sequence) = {
            let sessions = self.streams.0.lock().unwrap();
            let Some(session) = sessions.get(&control.stream_id) else {
                if control.operation == "stream.cancel" {
                    return Ok(vec![]);
                }
                return Err(unavailable());
            };
            if session.token != context.token {
                return Err(GatewayError::new(ErrorCode::Unauthorized, "stream caller mismatch"));
            }
            (session.cancel.clone(), session.handle.clone(), session.sequence)
        };
        let mut cancelled = cancel.subscribe();
        match control.operation.as_str() {
            "stream.open" => {
                let route = control.route.ok_or_else(argument)?;
                let source = tokio::select! {
                    biased;
                    _ = async { if !*cancelled.borrow() { let _ = cancelled.changed().await; } } => Err(unavailable()),
                    source = self.registry.open_stream(&route, payload, context.core(), Some(&self.owner)) => source,
                };
                let source = match source {
                    Ok(source) => source,
                    Err(error) => {
                        self.remove_stream(&control.stream_id, &cancel);
                        return Err(error);
                    }
                };
                let admission = Arc::new(stream::Admission {
                    cancel: watch::channel(false).0,
                    caller: context.token.clone(),
                    owner: self.owner.instance(),
                });
                let policy = self
                    .registry
                    .manifest(&self.owner)?
                    .routes
                    .into_iter()
                    .find(|registration| registration.route == route)
                    .and_then(|r| r.stream_policy)
                    .unwrap_or_default();
                let handle = stream::start(Box::pin(source), policy, context.token, self.owner.clone(), admission);
                let terminal = handle.life.terminal.subscribe();
                {
                    let mut sessions = self.streams.0.lock().unwrap();
                    let Some(session) = sessions.get_mut(&control.stream_id) else {
                        return Err(unavailable());
                    };
                    if !session.cancel.same_channel(&cancel) {
                        return Err(unavailable());
                    }
                    session.handle = Some(handle);
                }
                let endpoint = Arc::downgrade(self);
                let id = control.stream_id;
                ::napi::bindgen_prelude::spawn(async move {
                    let mut terminal = terminal;
                    while terminal.borrow().is_none() {
                        if terminal.changed().await.is_err() {
                            break;
                        }
                    }
                    if let Some(endpoint) = endpoint.upgrade() {
                        endpoint.remove_stream(&id, &cancel);
                    }
                });
                Ok(vec![])
            }
            "stream.next" => {
                let handle = handle.ok_or_else(argument)?;
                let item = handle.next().await?;
                if let Some(session) = self
                    .streams
                    .0
                    .lock()
                    .unwrap()
                    .get_mut(&control.stream_id)
                    .filter(|session| session.cancel.same_channel(&cancel))
                {
                    session.sequence = sequence
                        .checked_add(1)
                        .ok_or_else(|| GatewayError::new(ErrorCode::ResourceExhausted, "sequence exhausted"))?;
                }
                Ok(stream::encode_frame(sequence, item))
            }
            "stream.cancel" => {
                if let Some(session) = self.remove_stream(&control.stream_id, &cancel) {
                    session.cancel.send_replace(true);
                }
                if let Some(handle) = handle {
                    handle.cancel().await?;
                }
                Ok(vec![])
            }
            _ => Err(argument()),
        }
    }
    fn remove_stream(&self, id: &str, cancel: &watch::Sender<bool>) -> Option<Session> {
        let mut sessions = self.streams.0.lock().unwrap();
        if sessions
            .get(id)
            .is_some_and(|session| session.cancel.same_channel(cancel))
        {
            sessions.remove(id)
        } else {
            None
        }
    }
    pub(super) async fn remote_stream(
        self: &Arc<Self>,
        route: Route,
        payload: Vec<u8>,
        context: crate::CallContext,
    ) -> Result<stream::RemoteOpen, GatewayError> {
        let id = {
            let mut state = self.state.lock().unwrap();
            state.next_subscription += 1;
            format!("stream:{}", state.next_subscription)
        };
        let lease = StreamLease {
            endpoint: Arc::downgrade(self),
            id,
            token: context.caller().into(),
        };
        let control = lease.control("stream.open", Some(route));
        let policy = tokio::time::timeout(std::time::Duration::from_secs(10), self.outbound(control, payload))
            .await
            .map_err(|_| GatewayError::new(ErrorCode::Timeout, "remote stream open timed out"))??;
        let policy: stream::StreamPolicy = serde_json::from_slice(&policy).map_err(|_| argument())?;
        policy.validate()?;
        let source = Box::pin(futures_util::stream::try_unfold(
            (lease, 0u32),
            |(lease, seq)| async move {
                let endpoint = lease.endpoint.upgrade().ok_or_else(unavailable)?;
                let bytes = endpoint.outbound(lease.control("stream.next", None), vec![]).await?;
                match stream::decode_frame(bytes, seq)? {
                    None => Ok(None),
                    Some(bytes) => Ok(Some((
                        bytes,
                        (
                            lease,
                            seq.checked_add(1)
                                .ok_or_else(|| GatewayError::new(ErrorCode::ResourceExhausted, "sequence exhausted"))?,
                        ),
                    ))),
                }
            },
        ));
        Ok(stream::RemoteOpen { source, policy })
    }
}
struct StreamLease {
    endpoint: std::sync::Weak<Endpoint>,
    id: String,
    token: String,
}
impl StreamLease {
    fn control(&self, operation: &str, route: Option<Route>) -> Control {
        Control {
            version: CONTROL_VERSION,
            operation: operation.into(),
            context_token: self.token.clone(),
            route,
            event: None,
            subscription_id: None,
            filter_present: false,
            stream_id: Some(self.id.clone()),
        }
    }
}
impl Drop for StreamLease {
    fn drop(&mut self) {
        let Some(endpoint) = self.endpoint.upgrade() else {
            return;
        };
        let control = self.control("stream.cancel", None);
        ::napi::bindgen_prelude::spawn(async move {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(1), endpoint.outbound(control, vec![])).await;
        });
    }
}
