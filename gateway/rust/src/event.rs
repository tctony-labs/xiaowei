//! Explicit event exports and per-subscription delivery queues, extracted from
//! xw-tauri/event.rs. Unavailable sources retain subscription intent, not history.
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use prost::Message;
use serde::{Deserialize, Serialize};

use crate::invoke::{Owner, XwInvokeRegistry};
use crate::protocol::*;

type Validator = Arc<dyn Fn(Option<&[u8]>) -> Result<(), GatewayError> + Send + Sync>;
type Matcher = Arc<dyn Fn(&[u8], Option<&[u8]>) -> bool + Send + Sync>;
type Sink = Arc<dyn Fn(Vec<u8>) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventBackpressure {
    Ordered,
    Coalesce,
    Drop,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventDescriptor {
    pub name: String,
    pub policy: EventBackpressure,
}

#[derive(Clone)]
pub struct EventExportRegistration {
    pub name: String,
    pub policy: EventBackpressure,
    validate: Validator,
    matches: Matcher,
}

impl EventExportRegistration {
    pub fn typed<Payload, Filter, F>(policy: EventBackpressure, matcher: F) -> Self
    where
        Payload: Message + Default + prost::Name,
        Filter: Message + Default,
        F: Fn(&Payload, Option<&Filter>) -> bool + Send + Sync + 'static,
    {
        Self {
            name: Payload::full_name(),
            policy,
            validate: Arc::new(|filter| match filter {
                Some(bytes) => Filter::decode(bytes)
                    .map(|_| ())
                    .map_err(|_| GatewayError::new(ErrorCode::InvalidArgument, "invalid event filter")),
                None => Ok(()),
            }),
            matches: Arc::new(move |payload, filter| {
                let Ok(payload) = Payload::decode(payload) else {
                    return false;
                };
                let filter = match filter {
                    Some(bytes) => match Filter::decode(bytes) {
                        Ok(value) => Some(value),
                        Err(_) => return false,
                    },
                    None => None,
                };
                matcher(&payload, filter.as_ref())
            }),
        }
    }
}

struct QueueState {
    policy: EventBackpressure,
    pending: VecDeque<Vec<u8>>,
    draining: bool,
    active: bool,
}

struct DeliveryQueue {
    state: Mutex<QueueState>,
    sink: Sink,
}

impl DeliveryQueue {
    fn enqueue(self: &Arc<Self>, payload: Vec<u8>) {
        let mut state = self.state.lock().unwrap();
        if !state.active {
            return;
        }
        match state.policy {
            EventBackpressure::Drop if !state.pending.is_empty() => return,
            EventBackpressure::Coalesce => state.pending.clear(),
            _ => {}
        }
        state.pending.push_back(payload);
        if state.draining {
            return;
        }
        state.draining = true;
        drop(state);
        let queue = self.clone();
        tokio::spawn(async move {
            loop {
                let payload = {
                    let mut state = queue.state.lock().unwrap();
                    match state.pending.pop_front() {
                        Some(payload) if state.active => payload,
                        _ => {
                            state.draining = false;
                            return;
                        }
                    }
                };
                // Isolate sink panics so one subscriber cannot strand another queue.
                let sink = queue.sink.clone();
                let _ = tokio::spawn(async move { sink(payload).await }).await;
            }
        });
    }
    fn clear(&self) {
        self.state.lock().unwrap().pending.clear();
    }
    fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.active = false;
        state.pending.clear();
    }
}

struct Subscription {
    name: String,
    filter: Option<Vec<u8>>,
    caller: String,
    persistent: bool,
    queue: Arc<DeliveryQueue>,
}

#[derive(Default)]
pub(crate) struct EventState {
    entries: HashMap<String, (Owner, EventExportRegistration)>,
    subscriptions: HashMap<u64, Subscription>,
    next_id: u64,
}

impl EventState {
    pub(crate) fn manifest(&self, owner: &Owner) -> Vec<EventDescriptor> {
        let mut events: Vec<_> = self
            .entries
            .values()
            .filter(|(current, _)| current.same_instance(owner))
            .map(|(_, export)| EventDescriptor {
                name: export.name.clone(),
                policy: export.policy,
            })
            .collect();
        events.sort_by(|a, b| a.name.cmp(&b.name));
        events
    }
    pub(crate) fn validate_owner(&self, name: &str, exports: &[EventExportRegistration]) -> Result<(), GatewayError> {
        let mut names = HashSet::new();
        for export in exports {
            validate_name(&export.name)?;
            if !names.insert(&export.name)
                || self
                    .entries
                    .get(&export.name)
                    .is_some_and(|(owner, _)| owner.name != name)
            {
                return Err(GatewayError::new(ErrorCode::Conflict, "event already registered"));
            }
        }
        Ok(())
    }
    pub(crate) fn install_owner(&mut self, owner: &Owner, exports: Vec<EventExportRegistration>) {
        for export in exports {
            for subscription in self.subscriptions.values().filter(|s| s.name == export.name) {
                subscription.queue.state.lock().unwrap().policy = export.policy;
            }
            self.entries.insert(export.name.clone(), (owner.clone(), export));
        }
    }
    pub(crate) fn remove_owner(&mut self, owner: &Owner) {
        let names: HashSet<_> = self
            .entries
            .iter()
            .filter(|(_, (o, _))| o.same_instance(owner))
            .map(|(name, _)| name.clone())
            .collect();
        self.entries.retain(|_, (o, _)| !o.same_instance(owner));
        self.subscriptions.retain(|_, subscription| {
            if !names.contains(&subscription.name) {
                return true;
            }
            subscription.queue.clear();
            if subscription.persistent {
                true
            } else {
                subscription.queue.close();
                false
            }
        });
    }
}

/// Opaque subscription handle. Dropping it unsubscribes; close is idempotent.
pub struct SubscriptionHandle {
    registry: Arc<XwInvokeRegistry>,
    id: u64,
}
impl SubscriptionHandle {
    pub fn close(&self) {
        if let Some(subscription) = self
            .registry
            .state
            .lock()
            .unwrap()
            .events
            .subscriptions
            .remove(&self.id)
        {
            subscription.queue.close();
        }
    }
}
impl Drop for SubscriptionHandle {
    fn drop(&mut self) {
        self.close();
    }
}

impl XwInvokeRegistry {
    pub fn snapshot_events(&self) -> Vec<(String, EventBackpressure)> {
        let state = self.state.lock().unwrap();
        let mut entries: Vec<_> = state
            .events
            .entries
            .iter()
            .map(|(name, (_, e))| (name.clone(), e.policy))
            .collect();
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries
    }

    pub fn subscribe<F, Fut>(
        self: &Arc<Self>,
        context: &CallContext,
        name: &str,
        filter: Option<Vec<u8>>,
        persistent: bool,
        sink: F,
    ) -> Result<SubscriptionHandle, GatewayError>
    where
        F: Fn(Vec<u8>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        context.authorize(name, true)?;
        validate_name(name)?;
        let mut state = self.state.lock().unwrap();
        let policy = if let Some((_, export)) = state.events.entries.get(name) {
            (export.validate)(filter.as_deref())?;
            export.policy
        } else if persistent {
            EventBackpressure::Drop
        } else {
            return Err(GatewayError::new(ErrorCode::UnknownRoute, "event not exported"));
        };
        state.events.next_id += 1;
        let id = state.events.next_id;
        state.events.subscriptions.insert(
            id,
            Subscription {
                name: name.into(),
                filter,
                caller: context.caller().into(),
                persistent,
                queue: Arc::new(DeliveryQueue {
                    state: Mutex::new(QueueState {
                        policy,
                        pending: VecDeque::new(),
                        draining: false,
                        active: true,
                    }),
                    sink: Arc::new(move |payload| Box::pin(sink(payload))),
                }),
            },
        );
        Ok(SubscriptionHandle {
            registry: self.clone(),
            id,
        })
    }

    pub fn cleanup_caller(&self, caller: &str) {
        self.remote_events.cleanup_caller(caller);
        self.state
            .lock()
            .unwrap()
            .events
            .subscriptions
            .retain(|_, subscription| {
                if subscription.caller != caller {
                    return true;
                }
                subscription.queue.close();
                false
            });
    }

    pub fn publish(&self, owner: &Owner, name: &str, payload: Vec<u8>) -> Result<(), GatewayError> {
        let state = self.state.lock().unwrap();
        let (current, export) = state
            .events
            .entries
            .get(name)
            .ok_or_else(|| GatewayError::new(ErrorCode::UnknownRoute, "event not exported"))?;
        if !current.same_instance(owner) || owner.is_closed() {
            return Err(GatewayError::new(ErrorCode::OwnerUnavailable, "stale event source"));
        }
        for subscription in state.events.subscriptions.values().filter(|s| s.name == name) {
            if (export.validate)(subscription.filter.as_deref()).is_ok()
                && (export.matches)(&payload, subscription.filter.as_deref())
            {
                subscription.queue.enqueue(payload.clone());
            }
        }
        Ok(())
    }
}

/// The transport supplies a connection-bound subscription. Closing it must be
/// idempotent and target only that connection instance.
pub struct RemoteBinding {
    pub policy: EventBackpressure,
    pub close: Arc<dyn Fn() + Send + Sync>,
}
impl Drop for RemoteBinding {
    fn drop(&mut self) {
        (self.close)();
    }
}

pub type EventSink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;
type SubscribeFuture = Pin<Box<dyn Future<Output = Result<RemoteBinding, GatewayError>> + Send>>;
pub type EventTransport = Arc<dyn Fn(CallContext, String, Option<Vec<u8>>, EventSink) -> SubscribeFuture + Send + Sync>;

struct RemoteConsumer {
    context: CallContext,
    name: String,
    filter: Option<Vec<u8>>,
    persistent: bool,
    queue: Arc<DeliveryQueue>,
    binding: Option<RemoteBinding>,
    generation: u64,
}
#[derive(Default)]
struct RemoteState {
    next_id: u64,
    transport: Option<EventTransport>,
    consumers: HashMap<u64, RemoteConsumer>,
}

/// Consumer-side adapter. Replacing a transport invalidates old delivery closures
/// before replaying subscription intent; no event bytes are buffered offline.
#[derive(Clone, Default)]
pub struct RemoteEvents(Arc<Mutex<RemoteState>>);

pub struct RemoteSubscription {
    events: RemoteEvents,
    id: u64,
}
impl RemoteSubscription {
    pub fn close(&self) {
        // Drop the transport binding outside our lock (it can re-enter the registry).
        let removed = self.events.0.lock().unwrap().consumers.remove(&self.id);
        if let Some(consumer) = &removed {
            consumer.queue.close();
        }
        drop(removed);
    }
}
impl Drop for RemoteSubscription {
    fn drop(&mut self) {
        self.close();
    }
}

impl RemoteEvents {
    /// Permanently release transport and all subscription intents at endpoint shutdown.
    pub fn close(&self) {
        let (transport, consumers) = {
            let mut state = self.0.lock().unwrap();
            (state.transport.take(), std::mem::take(&mut state.consumers))
        };
        for consumer in consumers.values() {
            consumer.queue.close();
        }
        drop(consumers);
        drop(transport);
    }
    pub async fn set_transport(&self, transport: Option<EventTransport>) {
        let (bindings, removed, ids) = {
            let mut state = self.0.lock().unwrap();
            state.transport = transport;
            let mut bindings = Vec::new();
            let mut removed = Vec::new();
            for consumer in state.consumers.values_mut() {
                consumer.generation += 1;
                consumer.queue.clear();
                if let Some(binding) = consumer.binding.take() {
                    bindings.push(binding);
                }
            }
            let expired: Vec<_> = state
                .consumers
                .iter()
                .filter(|(_, c)| !c.persistent)
                .map(|(id, _)| *id)
                .collect();
            for id in expired {
                if let Some(consumer) = state.consumers.remove(&id) {
                    consumer.queue.close();
                    removed.push(consumer);
                }
            }
            (bindings, removed, state.consumers.keys().copied().collect::<Vec<_>>())
        };
        drop(bindings);
        drop(removed);
        for id in ids {
            let _ = self.activate(id).await;
        }
    }

    pub async fn subscribe<F, Fut>(
        &self,
        context: CallContext,
        name: &str,
        filter: Option<Vec<u8>>,
        persistent: bool,
        sink: F,
    ) -> Result<RemoteSubscription, GatewayError>
    where
        F: Fn(Vec<u8>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        context.authorize(name, true)?;
        validate_name(name)?;
        let id = {
            let mut state = self.0.lock().unwrap();
            state.next_id += 1;
            let id = state.next_id;
            state.consumers.insert(
                id,
                RemoteConsumer {
                    context,
                    name: name.into(),
                    filter,
                    persistent,
                    binding: None,
                    generation: 0,
                    queue: Arc::new(DeliveryQueue {
                        state: Mutex::new(QueueState {
                            policy: EventBackpressure::Drop,
                            pending: VecDeque::new(),
                            draining: false,
                            active: true,
                        }),
                        sink: Arc::new(move |payload| Box::pin(sink(payload))),
                    }),
                },
            );
            id
        };
        let handle = RemoteSubscription {
            events: self.clone(),
            id,
        };
        if let Err(error) = self.activate(id).await {
            if !persistent || !matches!(error.code, ErrorCode::UnknownRoute | ErrorCode::OwnerUnavailable) {
                handle.close();
                return Err(error);
            }
        }
        Ok(handle)
    }

    async fn activate(&self, id: u64) -> Result<(), GatewayError> {
        let (transport, context, name, filter, generation) = {
            let mut state = self.0.lock().unwrap();
            let transport = state
                .transport
                .clone()
                .ok_or_else(|| GatewayError::new(ErrorCode::OwnerUnavailable, "event transport unavailable"))?;
            let Some(consumer) = state.consumers.get_mut(&id) else {
                return Ok(());
            };
            consumer.generation += 1;
            (
                transport,
                consumer.context.clone(),
                consumer.name.clone(),
                consumer.filter.clone(),
                consumer.generation,
            )
        };
        let weak = Arc::downgrade(&self.0);
        let sink: EventSink = Arc::new(move |payload| {
            let Some(state) = weak.upgrade() else {
                return;
            };
            let state = state.lock().unwrap();
            if let Some(consumer) = state.consumers.get(&id) {
                // Before attach completes there is no acknowledged policy/lease.
                if consumer.generation == generation && consumer.binding.is_some() {
                    consumer.queue.enqueue(payload);
                }
            }
        });
        let result = transport(context, name, filter, sink).await;
        let mut state = self.0.lock().unwrap();
        if let Some(consumer) = state.consumers.get_mut(&id) {
            if consumer.generation == generation {
                let binding = result?;
                consumer.queue.state.lock().unwrap().policy = binding.policy;
                consumer.binding = Some(binding);
                return Ok(());
            }
        }
        drop(state);
        drop(result);
        Ok(())
    }

    pub fn cleanup_caller(&self, caller: &str) {
        let ids: Vec<_> = self
            .0
            .lock()
            .unwrap()
            .consumers
            .iter()
            .filter(|(_, c)| c.context.caller() == caller)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            RemoteSubscription {
                events: self.clone(),
                id,
            }
            .close();
        }
    }
}

pub enum EventSubscription {
    Local(SubscriptionHandle),
    Remote(RemoteSubscription),
}
impl EventSubscription {
    pub fn close(&self) {
        match self {
            Self::Local(handle) => handle.close(),
            Self::Remote(handle) => handle.close(),
        }
    }
}

impl crate::invoke::Client {
    /// Local first. The injected host transport owns remote subscription replay
    /// when an event owner appears; transport replacement handles reconnection.
    pub async fn subscribe<F, Fut>(
        &self,
        name: &str,
        filter: Option<Vec<u8>>,
        persistent: bool,
        sink: F,
    ) -> Result<EventSubscription, GatewayError>
    where
        F: Fn(Vec<u8>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        self.context().authorize(name, true)?;
        let sink = Arc::new(sink);
        let local_sink = sink.clone();
        match self
            .registry()
            .subscribe(self.context(), name, filter.clone(), false, move |payload| {
                local_sink(payload)
            }) {
            Ok(handle) => Ok(EventSubscription::Local(handle)),
            Err(error) if error.code == ErrorCode::UnknownRoute => self
                .registry()
                .remote_events
                .subscribe(self.context().clone(), name, filter, persistent, move |payload| {
                    sink(payload)
                })
                .await
                .map(EventSubscription::Remote),
            Err(error) => Err(error),
        }
    }
}
