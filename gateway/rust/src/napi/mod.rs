//! Native transport without exported addon symbols. Business addons own the
//! napi classes; this module owns their shared endpoint implementation.
use std::sync::{Arc, Mutex};

use ::napi::bindgen_prelude::{Buffer, Either, FnArgs, Promise};
use ::napi::threadsafe_function::ThreadsafeFunction;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::event::{EventSink, RemoteBinding, SubscriptionHandle};
use crate::invoke::Owner;
use crate::protocol::{CONTROL_VERSION, Route, WireResult};
use crate::{CallContext, ErrorCode, GatewayError, XwInvokeRegistry};

pub type Reply = Either<Buffer, String>;
pub type Callback = ThreadsafeFunction<
    FnArgs<(String, Buffer)>,
    Promise<Reply>,
    FnArgs<(String, Buffer)>,
    ::napi::Status,
    false,
    true,
    64,
>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub token: String,
    pub trusted: bool,
    #[serde(default)]
    pub invoke: Vec<String>,
    #[serde(default)]
    pub subscribe: Vec<String>,
}
impl Context {
    fn core(&self) -> CallContext {
        if self.trusted {
            CallContext::trusted(&self.token)
        } else {
            CallContext::restricted(&self.token, self.invoke.clone(), self.subscribe.clone())
        }
    }
}

/// Versioned control metadata is JSON; business and event messages remain Buffer.
/// Additional stream control operations can use the same independent callback path.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub version: u32,
    pub operation: String,
    pub context_token: String,
    pub route: Option<Route>,
    pub event: Option<String>,
    pub subscription_id: Option<String>,
    pub filter_present: bool,
}

struct State {
    callback: Option<Arc<Callback>>,
    origin: Option<Context>,
    ready: bool,
    next_subscription: u64,
    local_subscriptions: std::collections::HashMap<String, SubscriptionHandle>,
    remote_sinks: std::collections::HashMap<String, EventSink>,
}

pub struct Endpoint {
    pub registry: Arc<XwInvokeRegistry>,
    pub owner: Owner,
    state: Mutex<State>,
    closed: watch::Sender<bool>,
}

fn unavailable() -> GatewayError {
    GatewayError::new(ErrorCode::OwnerUnavailable, "native endpoint unavailable")
}
fn argument() -> GatewayError {
    GatewayError::new(ErrorCode::InvalidArgument, "invalid native control metadata")
}
fn parse<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, GatewayError> {
    serde_json::from_str(value).map_err(|_| argument())
}
pub fn reply(result: WireResult) -> Reply {
    match result {
        Ok(bytes) => Either::A(bytes.into()),
        Err(error) => Either::B(serde_json::to_string(&error).expect("serializable error")),
    }
}
fn from_reply(reply: Reply) -> WireResult {
    match reply {
        Either::A(bytes) => Ok(bytes.to_vec()),
        Either::B(error) => Err(parse(&error)?),
    }
}
fn callback_error(error: ::napi::Error) -> GatewayError {
    let code = match error.status {
        ::napi::Status::QueueFull => ErrorCode::ConcurrencyFull,
        ::napi::Status::Closing => ErrorCode::OwnerUnavailable,
        _ => ErrorCode::HandlerError,
    };
    GatewayError::new(code, "native callback failed")
}

impl Endpoint {
    pub fn new(registry: Arc<XwInvokeRegistry>, owner: Owner) -> Arc<Self> {
        Arc::new(Self {
            registry,
            owner,
            closed: watch::channel(false).0,
            state: Mutex::new(State {
                callback: None,
                origin: None,
                ready: false,
                next_subscription: 0,
                local_subscriptions: Default::default(),
                remote_sinks: Default::default(),
            }),
        })
    }
    pub fn manifest(&self) -> Result<String, GatewayError> {
        let mut manifest = serde_json::to_value(self.registry.manifest(&self.owner)?).map_err(|_| argument())?;
        manifest["controlVersion"] = CONTROL_VERSION.into();
        serde_json::to_string(&manifest).map_err(|_| argument())
    }
    pub fn bind(self: &Arc<Self>, callback: Arc<Callback>, origin: &str) -> Result<(), GatewayError> {
        let context: Context = parse(origin)?;
        if context.token.is_empty() {
            return Err(argument());
        }
        let mut state = self.state.lock().unwrap();
        if *self.closed.borrow() || state.callback.is_some() {
            return Err(unavailable());
        }
        state.callback = Some(callback);
        state.origin = Some(context);
        let endpoint = Arc::downgrade(self);
        self.registry.set_remote_invoker(move |route, payload, context| {
            let endpoint = endpoint.clone();
            async move {
                let endpoint = endpoint.upgrade().ok_or_else(unavailable)?;
                endpoint
                    .outbound(
                        Control {
                            version: CONTROL_VERSION,
                            operation: "invoke".into(),
                            context_token: context.caller().into(),
                            route: Some(route),
                            event: None,
                            subscription_id: None,
                            filter_present: false,
                        },
                        payload,
                    )
                    .await
            }
        });
        Ok(())
    }
    fn ready(&self) -> Result<(), GatewayError> {
        if *self.closed.borrow() || !self.state.lock().unwrap().ready {
            return Err(unavailable());
        }
        Ok(())
    }
    pub async fn activate(self: &Arc<Self>) -> Result<(), GatewayError> {
        {
            let mut state = self.state.lock().unwrap();
            if *self.closed.borrow() || state.callback.is_none() || state.ready {
                return Err(unavailable());
            }
            state.ready = true;
        }
        let endpoint = Arc::downgrade(self);
        self.registry
            .remote_events
            .set_transport(Some(Arc::new(move |context, event, filter, sink| {
                let endpoint = endpoint.clone();
                Box::pin(async move {
                    let endpoint = endpoint.upgrade().ok_or_else(unavailable)?;
                    endpoint.remote_subscribe(context, event, filter, sink).await
                })
            })))
            .await;
        Ok(())
    }
    async fn outbound(&self, control: Control, payload: Vec<u8>) -> WireResult {
        self.ready()?;
        let callback = self.state.lock().unwrap().callback.clone().ok_or_else(unavailable)?;
        let metadata = serde_json::to_string(&control).map_err(|_| argument())?;
        let mut closed = self.closed.subscribe();
        tokio::select! {
            biased;
            _ = async { if !*closed.borrow() { let _ = closed.changed().await; } } => Err(unavailable()),
            result = async {
                let promise = callback.call_async_catch((metadata, Buffer::from(payload)).into()).await
                    .map_err(callback_error)?;
                from_reply(promise.await.map_err(callback_error)?)
            } => result,
        }
    }
    pub async fn dispatch_local(self: &Arc<Self>, route: &str, payload: Vec<u8>, context: &str) -> WireResult {
        self.ready()?;
        let context: Context = parse(context)?;
        self.registry
            .dispatch_local(&self.owner, &parse(route)?, payload, context.core())
            .await
    }
    pub async fn invoke(self: &Arc<Self>, route: &str, payload: Vec<u8>) -> WireResult {
        self.ready()?;
        let origin = self.state.lock().unwrap().origin.clone().ok_or_else(unavailable)?;
        let mut closed = self.closed.subscribe();
        let route = parse(route)?;
        tokio::select! {
            biased;
            _ = async { if !*closed.borrow() { let _ = closed.changed().await; } } => Err(unavailable()),
            result = self.registry.call(&route, payload, origin.core()) => result,
        }
    }
    pub fn install_cleanup(self: &Arc<Self>, env: &::napi::Env) -> ::napi::Result<()> {
        env.add_env_cleanup_hook(Arc::downgrade(self), |endpoint| {
            if let Some(endpoint) = endpoint.upgrade() {
                drop(endpoint.shutdown());
            }
        })?;
        Ok(())
    }
    fn shutdown(&self) -> Option<Arc<Callback>> {
        if self.closed.send_replace(true) {
            return None;
        }
        self.registry.unregister_owner(&self.owner);
        let (callback, subscriptions) = {
            let mut state = self.state.lock().unwrap();
            state.ready = false;
            state.origin.take();
            state.remote_sinks.clear();
            (state.callback.take(), std::mem::take(&mut state.local_subscriptions))
        };
        drop(subscriptions);
        self.registry.remote_events.close();
        callback
    }
    pub async fn close(&self) -> WireResult {
        if let Some(callback) = self.shutdown() {
            let metadata = serde_json::to_string(&Control {
                version: CONTROL_VERSION,
                operation: "closed".into(),
                context_token: String::new(),
                route: None,
                event: None,
                subscription_id: None,
                filter_present: false,
            })
            .unwrap();
            // Notify the host after local shutdown. A broken host must not keep close pending indefinitely.
            tokio::time::timeout(std::time::Duration::from_secs(1), async {
                let promise = callback
                    .call_async_catch((metadata, Buffer::from(vec![])).into())
                    .await
                    .map_err(callback_error)?;
                from_reply(promise.await.map_err(callback_error)?)
            })
            .await
            .map_err(|_| GatewayError::new(ErrorCode::Timeout, "native close acknowledgement timed out"))??;
        }
        Ok(vec![])
    }

    async fn remote_subscribe(
        self: &Arc<Self>,
        context: CallContext,
        event: String,
        filter: Option<Vec<u8>>,
        sink: EventSink,
    ) -> Result<RemoteBinding, GatewayError> {
        self.ready()?;
        let id = {
            let mut state = self.state.lock().unwrap();
            state.next_subscription += 1;
            let id = state.next_subscription.to_string();
            state.remote_sinks.insert(id.clone(), sink);
            id
        };
        let lease = Arc::new(RemoteLease {
            endpoint: Arc::downgrade(self),
            id: id.clone(),
            token: context.caller().into(),
        });
        let bytes = self
            .outbound(
                Control {
                    version: CONTROL_VERSION,
                    operation: "subscribe".into(),
                    context_token: context.caller().into(),
                    route: None,
                    event: Some(event),
                    subscription_id: Some(id),
                    filter_present: filter.is_some(),
                },
                filter.unwrap_or_default(),
            )
            .await?;
        let policy = serde_json::from_slice(&bytes).map_err(|_| argument())?;
        Ok(RemoteBinding {
            policy,
            close: Arc::new(move || lease.close()),
        })
    }
    pub fn deliver(&self, id: &str, payload: Vec<u8>) -> WireResult {
        self.ready()?;
        let sink = self
            .state
            .lock()
            .unwrap()
            .remote_sinks
            .get(id)
            .cloned()
            .ok_or_else(unavailable)?;
        sink(payload);
        Ok(vec![])
    }
    pub fn subscribe_local(
        self: &Arc<Self>,
        id: &str,
        event: &str,
        filter: Option<Vec<u8>>,
        context: &str,
    ) -> Result<(), GatewayError> {
        self.ready()?;
        let context: Context = parse(context)?;
        let endpoint = Arc::downgrade(self);
        let subscription_id = id.to_string();
        let handle = self
            .registry
            .subscribe(&context.core(), event, filter, false, move |payload| {
                let endpoint = endpoint.clone();
                let id = subscription_id.clone();
                async move {
                    if let Some(endpoint) = endpoint.upgrade() {
                        let _ = endpoint
                            .outbound(
                                Control {
                                    version: CONTROL_VERSION,
                                    operation: "event".into(),
                                    context_token: String::new(),
                                    route: None,
                                    event: None,
                                    subscription_id: Some(id),
                                    filter_present: false,
                                },
                                payload,
                            )
                            .await;
                    }
                }
            })?;
        let mut state = self.state.lock().unwrap();
        if *self.closed.borrow() {
            return Err(unavailable());
        }
        if state.local_subscriptions.contains_key(id) {
            return Err(GatewayError::new(ErrorCode::Conflict, "duplicate native subscription"));
        }
        state.local_subscriptions.insert(id.into(), handle);
        Ok(())
    }
    pub fn unsubscribe_local(&self, id: &str) {
        let subscription = self.state.lock().unwrap().local_subscriptions.remove(id);
        drop(subscription);
    }
}

#[cfg(feature = "test-fixtures")]
pub mod fixture;

struct RemoteLease {
    endpoint: std::sync::Weak<Endpoint>,
    id: String,
    token: String,
}
impl RemoteLease {
    fn close(&self) {
        let Some(endpoint) = self.endpoint.upgrade() else {
            return;
        };
        if endpoint.state.lock().unwrap().remote_sinks.remove(&self.id).is_none() {
            return;
        }
        if *endpoint.closed.borrow() {
            return;
        }
        let id = self.id.clone();
        let token = self.token.clone();
        ::napi::bindgen_prelude::spawn(async move {
            let _ = endpoint
                .outbound(
                    Control {
                        version: CONTROL_VERSION,
                        operation: "unsubscribe".into(),
                        context_token: token,
                        route: None,
                        event: None,
                        subscription_id: Some(id),
                        filter_present: false,
                    },
                    vec![],
                )
                .await;
        });
    }
}
impl Drop for RemoteLease {
    fn drop(&mut self) {
        self.close();
    }
}
