//! Authenticated, network-scoped RPC. The client exports no application routes to the server.
use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use tokio_util::sync::CancellationToken;

use crate::wire::{self, Frame, Header, Manifest, Result, Route, StreamPolicy, WireError};

pub type EventSink = Arc<dyn Fn(Vec<u8>) -> BoxFuture<'static, Result<()>> + Send + Sync>;

struct Outgoing {
    bytes: Vec<u8>,
    queued: Arc<AtomicUsize>,
}

impl Drop for Outgoing {
    fn drop(&mut self) {
        self.queued.fetch_sub(self.bytes.len(), Ordering::AcqRel);
    }
}

struct State {
    pending: HashMap<String, oneshot::Sender<Result<Frame>>>,
    subscriptions: HashMap<String, EventSink>,
    streams: HashMap<String, watch::Sender<Option<Result<()>>>>,
    serving: HashMap<String, CancellationToken>,
    sequence: u64,
    reason: Option<WireError>,
}

pub struct Peer {
    pub generation: String,
    pub manifest: Manifest,
    state: Mutex<State>,
    outgoing: mpsc::Sender<Outgoing>,
    queued: Arc<AtomicUsize>,
    closed: CancellationToken,
}

impl Peer {
    pub async fn connect(url: &str, token: &str, cancel: CancellationToken) -> Result<Arc<Self>> {
        let work = async {
            let config = WebSocketConfig::default()
                .max_message_size(Some(
                    4 + wire::MAX_METADATA + wire::MAX_PAYLOAD + wire::MAX_OPTIONS,
                ))
                .max_frame_size(Some(
                    4 + wire::MAX_METADATA + wire::MAX_PAYLOAD + wire::MAX_OPTIONS,
                ));
            let (mut socket, _) = connect_async_with_config(url, Some(config), false)
                .await
                .map_err(|_| WireError::unavailable())?;
            let mut auth = Header::new("authenticate");
            auth.token = Some(token.into());
            auth.manifest = Some(Manifest::default());
            socket
                .send(Message::Binary(wire::encode(auth, &[], &[])?.into()))
                .await
                .map_err(|_| WireError::unavailable())?;
            let bytes = match socket.next().await {
                Some(Ok(Message::Binary(bytes))) => bytes,
                _ => return Err(WireError::unavailable()),
            };
            let ready = wire::decode(&bytes)?.header;
            if let Some(error) = ready.error {
                return Err(error);
            }
            if ready.op != "ready" || ready.generation.is_empty() {
                return Err(WireError::unavailable());
            }
            let manifest = ready.manifest.ok_or_else(WireError::unavailable)?;
            manifest.validate()?;
            let (outgoing, mut rx) = mpsc::channel::<Outgoing>(wire::LIMIT + 32);
            let closed = CancellationToken::new();
            let peer = Arc::new(Self {
                generation: ready.generation,
                manifest,
                state: Mutex::new(State {
                    pending: HashMap::new(),
                    subscriptions: HashMap::new(),
                    streams: HashMap::new(),
                    serving: HashMap::new(),
                    sequence: 0,
                    reason: None,
                }),
                outgoing,
                queued: Arc::new(AtomicUsize::new(0)),
                closed: closed.clone(),
            });
            let (mut write, mut read) = socket.split();
            let weak = Arc::downgrade(&peer);
            let writer_closed = closed.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        biased;
                        _ = writer_closed.cancelled() => break,
                        value = rx.recv() => {
                            let Some(value) = value else {
                                break;
                            };
                            let message = Message::Binary(value.bytes.clone().into());
                            let sent = tokio::select! {
                                _ = writer_closed.cancelled() => break,
                                sent = write.send(message) => sent,
                            };
                            if sent.is_err() {
                                break;
                            }
                        }
                    }
                }
                if let Some(peer) = weak.upgrade() {
                    peer.close();
                }
                // A broken socket must not keep shutdown or application exit waiting.
                let _ = tokio::time::timeout(std::time::Duration::from_millis(250), write.close())
                    .await;
            });
            let weak = Arc::downgrade(&peer);
            tokio::spawn(async move {
                loop {
                    let message = tokio::select! {
                        biased;
                        _ = closed.cancelled() => break,
                        message = read.next() => message,
                    };
                    let Some(peer) = weak.upgrade() else { break };
                    match message {
                        Some(Ok(Message::Binary(bytes))) => {
                            if peer.receive(&bytes).is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                        _ => break,
                    }
                }
                if let Some(peer) = weak.upgrade() {
                    peer.close();
                }
            });
            Ok(peer)
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(WireError::new("CANCELLED", "connection cancelled")),
            result = tokio::time::timeout(std::time::Duration::from_secs(5), work) => {
                result.map_err(|_| WireError::new("TIMEOUT", "authentication timed out"))?
            }
        }
    }

    pub fn can_invoke(&self, route: &Route) -> bool {
        !self.closed.is_cancelled() && self.remote_route(route).is_ok()
    }

    fn remote_route(&self, route: &Route) -> Result<&Route> {
        let actual = self
            .manifest
            .routes
            .iter()
            .find(|value| value.name == route.name)
            .ok_or_else(|| WireError::new("UNKNOWN_ROUTE", "remote route not exported"))?;
        if !actual.compatible(route) {
            return Err(WireError::new(
                "INCOMPATIBLE",
                "remote route contract mismatch",
            ));
        }
        Ok(actual)
    }

    fn next_id(&self) -> String {
        let mut state = self.state.lock().unwrap();
        state.sequence += 1;
        format!("c:{}", state.sequence)
    }

    fn send(&self, mut header: Header, payload: &[u8], options: &[u8]) -> Result<()> {
        if self.closed.is_cancelled() {
            return Err(WireError::unavailable());
        }
        header.generation.clone_from(&self.generation);
        let bytes = wire::encode(header, payload, options)?;
        let len = bytes.len();
        let prior = self.queued.fetch_add(len, Ordering::AcqRel);
        let outgoing = Outgoing {
            bytes,
            queued: self.queued.clone(),
        };
        if prior + len > 2 * wire::MAX_PAYLOAD || self.outgoing.try_send(outgoing).is_err() {
            // outgoing's Drop releases the byte quota on either failure path.
            self.close();
            return Err(WireError::new(
                "RESOURCE_EXHAUSTED",
                "WebSocket send buffer full",
            ));
        }
        Ok(())
    }

    async fn request(
        self: &Arc<Self>,
        mut header: Header,
        payload: &[u8],
        options: &[u8],
        timeout_ms: u32,
        cancel: CancellationToken,
    ) -> Result<Frame> {
        if cancel.is_cancelled() {
            return Err(WireError::new("CANCELLED", "request cancelled"));
        }
        let control = matches!(
            header.op.as_str(),
            "cancel" | "stream.cancel" | "unsubscribe" | "ping"
        );
        let id = header.id.get_or_insert_with(|| self.next_id()).clone();
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state.lock().unwrap();
            if self.closed.is_cancelled() {
                return Err(WireError::unavailable());
            }
            if state.pending.len() >= wire::LIMIT + if control { 32 } else { 0 } {
                return Err(WireError::new(
                    "RESOURCE_EXHAUSTED",
                    "WebSocket requests full",
                ));
            }
            state.pending.insert(id.clone(), tx);
        }
        let mut guard = Pending {
            peer: Arc::downgrade(self),
            id,
            cancel_remote: !control,
        };
        self.send(header, payload, options)?;
        let duration = std::time::Duration::from_millis(timeout_ms.into());
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(WireError::new("CANCELLED", "request cancelled")),
            result = tokio::time::timeout(duration, rx) => {
                match result {
                    Ok(Ok(result)) => {
                        guard.cancel_remote = false;
                        result
                    }
                    Ok(Err(_)) => Err(WireError::unavailable()),
                    Err(_) => Err(WireError::new("TIMEOUT", "WebSocket request timed out")),
                }
            }
        };
        result
    }

    pub async fn invoke(
        self: &Arc<Self>,
        route: Route,
        payload: Vec<u8>,
        timeout_ms: u32,
        cancel: CancellationToken,
    ) -> Result<Vec<u8>> {
        let actual = self.remote_route(&route)?;
        if route.kind != "unary" {
            return Err(WireError::new("WRONG_METHOD_KIND", "expected unary method"));
        }
        let limit = actual
            .timeout_ms
            .unwrap_or(30_000)
            .saturating_add(1000)
            .min(i32::MAX as u32);
        let limit = if timeout_ms == 0 {
            limit
        } else {
            limit.min(timeout_ms)
        };
        let mut header = Header::new("invoke");
        header.route = Some(route);
        Ok(self
            .request(header, &payload, &[], limit, cancel)
            .await?
            .payload)
    }

    pub async fn ping(self: &Arc<Self>) -> Result<()> {
        self.request(
            Header::new("ping"),
            &[],
            &[],
            5000,
            CancellationToken::new(),
        )
        .await?;
        Ok(())
    }

    fn receive(self: &Arc<Self>, bytes: &[u8]) -> Result<()> {
        let frame = wire::decode(bytes)?;
        let h = &frame.header;
        if h.generation != self.generation {
            return Err(WireError::unavailable());
        }
        if h.op == "connection.end" {
            self.close_with(h.error.clone().unwrap_or_else(WireError::unavailable));
            return Ok(());
        }
        if h.op == "result" {
            let pending = self
                .state
                .lock()
                .unwrap()
                .pending
                .remove(h.id.as_deref().unwrap_or(""));
            if let Some(pending) = pending {
                let result = if let Some(error) = &h.error {
                    Err(error.clone())
                } else {
                    Ok(frame)
                };
                let _ = pending.send(result);
            }
            return Ok(());
        }
        if h.op == "stream.end" {
            let stream = self
                .state
                .lock()
                .unwrap()
                .streams
                .remove(h.target.as_deref().unwrap_or(""));
            if let Some(stream) = stream {
                stream.send_replace(Some(h.error.clone().map_or(Ok(()), Err)));
            }
            return Ok(());
        }
        let id =
            h.id.as_ref()
                .filter(|id| id.starts_with("s:"))
                .ok_or_else(WireError::unavailable)?
                .clone();
        let mut response = Header::new("result");
        response.id = Some(id.clone());
        match h.op.as_str() {
            "ping" => self.send(response, &[], &[]),
            "cancel" => {
                if let Some(cancel) = self
                    .state
                    .lock()
                    .unwrap()
                    .serving
                    .get(h.target.as_deref().unwrap_or(""))
                {
                    cancel.cancel();
                }
                self.send(response, &[], &[])
            }
            "event" => {
                let cancel = CancellationToken::new();
                let sink = {
                    let mut state = self.state.lock().unwrap();
                    if state.serving.len() >= wire::LIMIT || state.serving.contains_key(&id) {
                        return Err(WireError::new(
                            "RESOURCE_EXHAUSTED",
                            "event deliveries full",
                        ));
                    }
                    state.serving.insert(id.clone(), cancel.clone());
                    state
                        .subscriptions
                        .get(h.target.as_deref().unwrap_or(""))
                        .cloned()
                };
                let weak = Arc::downgrade(self);
                let closed = self.closed.clone();
                tokio::spawn(async move {
                    let result = tokio::select! {
                        _ = closed.cancelled() => return,
                        _ = cancel.cancelled() => {
                            Err(WireError::new("CANCELLED", "event cancelled"))
                        },
                        result = async {
                            if let Some(sink) = sink {
                                sink(frame.payload).await
                            } else {
                                Ok(())
                            }
                        } => result,
                    };
                    if let Some(peer) = weak.upgrade() {
                        peer.state.lock().unwrap().serving.remove(&id);
                        response.error = result.err();
                        if peer.send(response, &[], &[]).is_err() {
                            peer.close();
                        }
                    }
                });
                Ok(())
            }
            _ => {
                response.error = Some(WireError::new("UNAUTHORIZED", "client exports no routes"));
                self.send(response, &[], &[])
            }
        }
    }

    pub async fn subscribe(
        self: &Arc<Self>,
        event: &str,
        filter: &[u8],
        sink: EventSink,
    ) -> Result<Subscription> {
        if !self.manifest.events.iter().any(|value| value.name == event) {
            return Err(WireError::new("UNKNOWN_ROUTE", "event not exported"));
        }
        let id = self.next_id();
        {
            let mut state = self.state.lock().unwrap();
            if state.subscriptions.len() >= wire::LIMIT {
                return Err(WireError::new("RESOURCE_EXHAUSTED", "subscriptions full"));
            }
            state.subscriptions.insert(id.clone(), sink);
        }
        let subscription = Subscription {
            peer: Arc::downgrade(self),
            id: id.clone(),
        };
        let mut header = Header::new("subscribe");
        header.id = Some(id);
        header.event = Some(event.into());
        self.request(header, filter, &[], 5000, CancellationToken::new())
            .await?;
        Ok(subscription)
    }

    pub async fn stream(
        self: &Arc<Self>,
        route: Route,
        payload: &[u8],
        cancel: CancellationToken,
    ) -> Result<ResponseStream> {
        let actual = self.remote_route(&route)?;
        if route.kind != "serverStreaming" {
            return Err(WireError::new(
                "WRONG_METHOD_KIND",
                "expected streaming method",
            ));
        }
        let open_ms = actual
            .stream_policy
            .as_ref()
            .map_or(10_000, |p| p.open_timeout_ms);
        let id = self.next_id();
        let (tx, terminal) = watch::channel(None);
        {
            let mut state = self.state.lock().unwrap();
            if state.streams.len() >= 32 {
                return Err(WireError::new("RESOURCE_EXHAUSTED", "stream quota full"));
            }
            state.streams.insert(id.clone(), tx);
        }
        let mut stream = ResponseStream {
            peer: self.clone(),
            id: id.clone(),
            terminal,
            cancel: cancel.clone(),
            policy: None,
            finished: false,
            failure: None,
        };
        let mut header = Header::new("stream.open");
        header.route = Some(route);
        header.id = Some(id);
        let response = self
            .request(header, payload, &[], open_ms.saturating_add(1000), cancel)
            .await?;
        let policy = response.header.policy.ok_or_else(WireError::unavailable)?;
        policy.validate()?;
        stream.policy = Some(policy);
        Ok(stream)
    }

    fn cancel_remote(self: &Arc<Self>, op: &str, target: String) {
        if self.closed.is_cancelled() {
            return;
        }
        let mut header = Header::new(op);
        header.target = Some(target);
        let peer = self.clone();
        // Drop may run during runtime teardown. Never panic or start an unbounded cleanup.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = peer
                    .request(header, &[], &[], 1500, CancellationToken::new())
                    .await;
            });
        }
    }

    pub async fn closed(&self) -> WireError {
        self.closed.cancelled().await;
        self.state
            .lock()
            .unwrap()
            .reason
            .clone()
            .unwrap_or_else(WireError::unavailable)
    }

    pub fn close(&self) {
        self.close_with(WireError::unavailable());
    }

    fn close_with(&self, reason: WireError) {
        let mut state = self.state.lock().unwrap();
        if self.closed.is_cancelled() {
            return;
        }
        state.reason = Some(reason.clone());
        self.closed.cancel();
        for (_, pending) in state.pending.drain() {
            let _ = pending.send(Err(reason.clone()));
        }
        for (_, stream) in state.streams.drain() {
            stream.send_replace(Some(Err(reason.clone())));
        }
        for (_, cancel) in state.serving.drain() {
            cancel.cancel();
        }
        state.subscriptions.clear();
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.close();
    }
}

struct Pending {
    peer: Weak<Peer>,
    id: String,
    cancel_remote: bool,
}

impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(peer) = self.peer.upgrade() {
            peer.state.lock().unwrap().pending.remove(&self.id);
            if self.cancel_remote {
                peer.cancel_remote("cancel", self.id.clone());
            }
        }
    }
}

pub struct Subscription {
    peer: Weak<Peer>,
    id: String,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(peer) = self.peer.upgrade() {
            peer.state.lock().unwrap().subscriptions.remove(&self.id);
            peer.cancel_remote("unsubscribe", self.id.clone());
        }
    }
}

pub struct ResponseStream {
    peer: Arc<Peer>,
    id: String,
    terminal: watch::Receiver<Option<Result<()>>>,
    cancel: CancellationToken,
    policy: Option<StreamPolicy>,
    finished: bool,
    failure: Option<WireError>,
}

impl ResponseStream {
    pub fn policy(&self) -> &StreamPolicy {
        self.policy.as_ref().unwrap()
    }

    pub async fn next(&mut self) -> Result<Option<Vec<u8>>> {
        if self.finished {
            return self.failure.clone().map_or(Ok(None), Err);
        }
        let terminal = self.terminal.borrow().clone();
        if let Some(result) = terminal {
            self.finished = true;
            self.failure = result.as_ref().err().cloned();
            return result.map(|_| None);
        }
        let mut header = Header::new("stream.next");
        header.target = Some(self.id.clone());
        let timeout_ms = self.policy().producer_idle_ms.saturating_add(1000);
        let result = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(WireError::new("CANCELLED", "stream cancelled")),
            _ = self.terminal.changed() => {
                self.finished = true;
                let result = self.terminal.borrow().clone()
                    .unwrap_or_else(|| Err(WireError::unavailable()));
                self.failure = result.as_ref().err().cloned();
                return result.map(|_| None);
            }
            result = self.peer.request(
                header, &[], &[], timeout_ms,
                self.cancel.clone(),
            ) => result,
        };
        match result {
            Ok(frame) if frame.header.done => {
                self.finished = true;
                self.peer.state.lock().unwrap().streams.remove(&self.id);
                Ok(None)
            }
            Ok(frame) if frame.payload.len() <= self.policy().max_chunk_bytes as usize => {
                Ok(Some(frame.payload))
            }
            result => {
                let error = result.err().unwrap_or_else(WireError::unavailable);
                self.cancel();
                self.failure = Some(error.clone());
                Err(error)
            }
        }
    }

    pub fn cancel(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.failure = Some(WireError::new("CANCELLED", "stream cancelled"));
        self.peer.state.lock().unwrap().streams.remove(&self.id);
        self.peer.cancel_remote("stream.cancel", self.id.clone());
    }
}

impl Drop for ResponseStream {
    fn drop(&mut self) {
        self.cancel();
    }
}
