//! Extracted from xw-tauri/invoke.rs: owner batches, local-first dispatch and
//! immediate semaphore admission. Transport and caller context replace Tauri.
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tokio::sync::{Semaphore, watch};

use crate::event::{EventExportRegistration, EventState};
use crate::protocol::*;

type InvokeFuture = Pin<Box<dyn Future<Output = WireResult> + Send>>;
pub type InvokeHandler = Arc<dyn Fn(Vec<u8>, Client) -> InvokeFuture + Send + Sync>;
type RemoteInvoker = Arc<dyn Fn(Route, Vec<u8>, CallContext) -> InvokeFuture + Send + Sync>;

pub struct InvokeRegistration {
    pub route: Route,
    pub timeout: Duration,
    pub max_concurrency: usize,
    pub handler: Option<InvokeHandler>,
}

impl InvokeRegistration {
    pub fn unary<F, Fut>(route: Route, handler: F) -> Self
    where
        F: Fn(Vec<u8>, Client) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = WireResult> + Send + 'static,
    {
        Self {
            route,
            timeout: Duration::from_secs(30),
            max_concurrency: 32,
            handler: Some(Arc::new(move |payload, client| Box::pin(handler(payload, client)))),
        }
    }

    pub fn stream(route: Route) -> Self {
        Self {
            route,
            timeout: Duration::from_secs(30),
            max_concurrency: 32,
            handler: None,
        }
    }
}

#[derive(Clone)]
struct Entry {
    owner: Owner,
    route: Route,
    timeout: Duration,
    semaphore: Arc<Semaphore>,
    max_concurrency: usize,
    handler: Option<InvokeHandler>,
}

#[derive(Clone)]
pub struct Owner {
    pub(crate) id: u64,
    pub(crate) name: String,
    pub(crate) closed: watch::Sender<bool>,
}

impl Owner {
    pub(crate) fn same_instance(&self, other: &Self) -> bool {
        self.closed.same_channel(&other.closed)
    }
    pub fn instance(&self) -> u64 {
        self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }
}

#[derive(Default)]
pub(crate) struct State {
    next_owner: u64,
    owners: HashMap<String, Owner>,
    entries: HashMap<String, Entry>,
    pub(crate) events: EventState,
}

#[derive(Default)]
pub struct XwInvokeRegistry {
    pub(crate) state: Mutex<State>,
    pub remote_events: crate::event::RemoteEvents,
    remote: RwLock<Option<RemoteInvoker>>,
}

#[derive(Clone)]
pub struct Client {
    registry: Arc<XwInvokeRegistry>,
    context: CallContext,
}

impl Client {
    pub async fn invoke(&self, route: &Route, payload: Vec<u8>) -> WireResult {
        self.registry.call(route, payload, self.context.clone()).await
    }
    pub fn context(&self) -> &CallContext {
        &self.context
    }
    pub fn registry(&self) -> &Arc<XwInvokeRegistry> {
        &self.registry
    }
}

impl XwInvokeRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn client(self: &Arc<Self>, context: CallContext) -> Client {
        Client {
            registry: self.clone(),
            context,
        }
    }

    /// Routes and events are validated together before replacing an owner instance.
    pub fn register_owner(
        &self,
        name: &str,
        registrations: Vec<InvokeRegistration>,
        events: Vec<EventExportRegistration>,
    ) -> Result<Owner, GatewayError> {
        validate_name(name)?;
        let mut state = self.state.lock().unwrap();
        let mut names = HashSet::new();
        for registration in &registrations {
            registration.route.validate()?;
            if !names.insert(&registration.route.name)
                || state
                    .entries
                    .get(&registration.route.name)
                    .is_some_and(|entry| entry.owner.name != name)
            {
                return Err(GatewayError::new(ErrorCode::Conflict, "route already registered"));
            }
            if registration.max_concurrency == 0
                || registration.max_concurrency > Semaphore::MAX_PERMITS
                || registration.timeout.is_zero()
                || (registration.route.kind == MethodKind::Unary) != registration.handler.is_some()
            {
                return Err(GatewayError::new(
                    ErrorCode::InvalidArgument,
                    "invalid execution policy or handler kind",
                ));
            }
        }
        state.events.validate_owner(name, &events)?;
        if let Some(old) = state.owners.remove(name) {
            old.closed.send_replace(true);
            state.events.remove_owner(&old);
        }
        state.entries.retain(|_, entry| entry.owner.name != name);
        state.next_owner += 1;
        let owner = Owner {
            id: state.next_owner,
            name: name.into(),
            closed: watch::channel(false).0,
        };
        for registration in registrations {
            state.entries.insert(
                registration.route.name.clone(),
                Entry {
                    owner: owner.clone(),
                    route: registration.route,
                    timeout: registration.timeout,
                    semaphore: Arc::new(Semaphore::new(registration.max_concurrency)),
                    max_concurrency: registration.max_concurrency,
                    handler: registration.handler,
                },
            );
        }
        state.events.install_owner(&owner, events);
        state.owners.insert(name.into(), owner.clone());
        Ok(owner)
    }

    pub fn unregister_owner(&self, owner: &Owner) {
        let mut state = self.state.lock().unwrap();
        if !state
            .owners
            .get(&owner.name)
            .is_some_and(|current| current.same_instance(owner))
        {
            return;
        }
        owner.closed.send_replace(true);
        state.owners.remove(&owner.name);
        state.entries.retain(|_, entry| !entry.owner.same_instance(owner));
        state.events.remove_owner(owner);
    }

    pub fn manifest(&self, owner: &Owner) -> Result<Manifest, GatewayError> {
        let state = self.state.lock().unwrap();
        if !state
            .owners
            .get(&owner.name)
            .is_some_and(|current| current.same_instance(owner))
        {
            return Err(GatewayError::new(ErrorCode::OwnerUnavailable, "owner instance closed"));
        }
        let mut routes: Vec<_> = state
            .entries
            .values()
            .filter(|entry| entry.owner.same_instance(owner))
            .map(|entry| RouteRegistration {
                route: entry.route.clone(),
                timeout_ms: entry.timeout.as_millis().min(u64::MAX as u128) as u64,
                max_concurrency: entry.max_concurrency,
            })
            .collect();
        routes.sort_by(|a, b| a.route.name.cmp(&b.route.name));
        Ok(Manifest {
            routes,
            events: state.events.manifest(owner),
        })
    }

    pub fn snapshot_routes(&self) -> Vec<Route> {
        let mut routes: Vec<_> = self
            .state
            .lock()
            .unwrap()
            .entries
            .values()
            .map(|e| e.route.clone())
            .collect();
        routes.sort_by(|a, b| a.name.cmp(&b.name));
        routes
    }

    pub fn set_remote_invoker<F, Fut>(&self, invoker: F)
    where
        F: Fn(Route, Vec<u8>, CallContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = WireResult> + Send + 'static,
    {
        *self.remote.write().unwrap() = Some(Arc::new(move |route, payload, context| {
            Box::pin(invoker(route, payload, context))
        }));
    }

    pub async fn call(self: &Arc<Self>, route: &Route, payload: Vec<u8>, context: CallContext) -> WireResult {
        context.authorize(&route.name, false)?;
        route.validate()?;
        let entry = self.state.lock().unwrap().entries.get(&route.name).cloned();
        if let Some(entry) = entry {
            return self.execute(entry, route, payload, context).await;
        }
        let remote = self
            .remote
            .read()
            .unwrap()
            .clone()
            .ok_or_else(|| GatewayError::new(ErrorCode::UnknownRoute, "route not registered"))?;
        remote(route.clone(), payload, context).await
    }

    /// Inbound transport dispatch never falls back, preventing forwarding loops.
    pub async fn dispatch_local(
        self: &Arc<Self>,
        owner: &Owner,
        route: &Route,
        payload: Vec<u8>,
        context: CallContext,
    ) -> WireResult {
        context.authorize(&route.name, false)?;
        let entry = self
            .state
            .lock()
            .unwrap()
            .entries
            .get(&route.name)
            .cloned()
            .ok_or_else(|| GatewayError::new(ErrorCode::UnknownRoute, "route not registered"))?;
        if !entry.owner.same_instance(owner) || owner.is_closed() {
            return Err(GatewayError::new(ErrorCode::OwnerUnavailable, "owner instance closed"));
        }
        self.execute(entry, route, payload, context).await
    }

    async fn execute(
        self: &Arc<Self>,
        entry: Entry,
        route: &Route,
        payload: Vec<u8>,
        context: CallContext,
    ) -> WireResult {
        entry.route.accepts(route)?;
        if entry.owner.is_closed() {
            return Err(GatewayError::new(ErrorCode::OwnerUnavailable, "owner instance closed"));
        }
        let permit = entry
            .semaphore
            .clone()
            .try_acquire_owned()
            .map_err(|_| GatewayError::new(ErrorCode::ConcurrencyFull, "route concurrency full"))?;
        let handler = entry.handler.unwrap();
        let client = self.client(context);
        // The task retains admission until the actual handler exits, even after a
        // timeout, caller drop or owner close. Never abort a task awaiting blocking work.
        let task = tokio::spawn(async move {
            let _permit = permit;
            handler(payload, client).await
        });
        let mut closed = entry.owner.closed.subscribe();
        tokio::select! {
            biased;
            _ = async { if !*closed.borrow() { let _ = closed.changed().await; } } => {
                Err(GatewayError::new(ErrorCode::OwnerUnavailable, "owner instance closed"))
            }
            result = tokio::time::timeout(entry.timeout, task) => match result {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(GatewayError::new(ErrorCode::HandlerError, "handler panicked")),
                Err(_) => Err(GatewayError::new(ErrorCode::Timeout, "handler timed out")),
            }
        }
    }
}
