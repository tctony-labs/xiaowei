//! Pull-only response streams. The actor polls the source exactly once per next.
use crate::invoke::Owner;
use crate::protocol::{ErrorCode, GatewayError};
use futures_util::{FutureExt, Stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;
use std::sync::{
    Arc, Weak,
    atomic::{AtomicBool, Ordering},
};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};

pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>, GatewayError>> + Send>>;
pub type OpenFuture = Pin<Box<dyn Future<Output = Result<ByteStream, GatewayError>> + Send>>;
pub type StreamHandler = Arc<dyn Fn(Vec<u8>, crate::Client) -> OpenFuture + Send + Sync>;
pub struct RemoteOpen {
    pub source: ByteStream,
    pub policy: StreamPolicy,
}
pub type RemoteOpenFuture = Pin<Box<dyn Future<Output = Result<RemoteOpen, GatewayError>> + Send>>;
pub type RemoteStream = Arc<dyn Fn(crate::Route, Vec<u8>, crate::CallContext) -> RemoteOpenFuture + Send + Sync>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StreamPolicy {
    pub max_chunk_bytes: usize,
    pub queue_items: usize,
    pub queue_bytes: usize,
    pub max_owner_streams: usize,
    pub max_caller_streams: usize,
    pub open_timeout_ms: u64,
    pub producer_idle_ms: u64,
    pub consumer_idle_ms: u64,
    pub total_ms: u64,
}
impl Default for StreamPolicy {
    fn default() -> Self {
        Self {
            max_chunk_bytes: 1024 * 1024,
            queue_items: 16,
            queue_bytes: 4 * 1024 * 1024,
            max_owner_streams: 128,
            max_caller_streams: 32,
            open_timeout_ms: 10_000,
            producer_idle_ms: 60_000,
            consumer_idle_ms: 60_000,
            total_ms: 0,
        }
    }
}
impl StreamPolicy {
    pub fn validate(&self) -> Result<(), GatewayError> {
        for (value, max) in [
            (self.max_chunk_bytes as u64, 64 * 1024 * 1024),
            (self.queue_bytes as u64, 64 * 1024 * 1024),
            (self.queue_items as u64, 4096),
            (self.max_owner_streams as u64, 4096),
            (self.max_caller_streams as u64, 4096),
            (self.open_timeout_ms, 2_147_483_647),
            (self.producer_idle_ms, 2_147_483_647),
            (self.consumer_idle_ms, 2_147_483_647),
        ] {
            if value == 0 || value > max {
                return Err(error(ErrorCode::InvalidArgument, "invalid stream policy"));
            }
        }
        if self.total_ms > 2_147_483_647 {
            return Err(error(ErrorCode::InvalidArgument, "invalid total timeout"));
        }
        Ok(())
    }
}
pub(crate) fn error(code: ErrorCode, message: &str) -> GatewayError {
    GatewayError::new(code, message)
}
type Item = Result<Option<Vec<u8>>, GatewayError>;
type Request = oneshot::Sender<Item>;
pub(crate) struct Life {
    pub caller: String,
    pub cancel: watch::Sender<bool>,
    pub(crate) terminal: watch::Sender<Option<Result<(), GatewayError>>>,
    busy: AtomicBool,
    requests: mpsc::Sender<Request>,
}
impl Drop for Life {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}
#[derive(Clone)]
pub struct StreamHandle {
    pub(crate) life: Arc<Life>,
}
impl StreamHandle {
    pub fn is_terminal(&self) -> bool {
        self.life.terminal.borrow().is_some()
    }
    pub fn cancel_now(&self) {
        self.life.cancel.send_replace(true);
    }
    pub async fn cancel(&self) -> Result<(), GatewayError> {
        self.cancel_now();
        let mut terminal = self.life.terminal.subscribe();
        tokio::time::timeout(Duration::from_secs(1), async {
            while terminal.borrow().is_none() {
                if terminal.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
        .map_err(|_| error(ErrorCode::Timeout, "producer cleanup timed out"))
    }
    pub async fn next(&self) -> Item {
        if let Some(result) = self.life.terminal.borrow().clone() {
            return result.map(|_| None);
        }
        if self.life.busy.swap(true, Ordering::AcqRel) {
            return Err(error(ErrorCode::ConcurrencyFull, "one pending next per stream"));
        }
        struct Pending<'a>(&'a AtomicBool, &'a watch::Sender<bool>, bool);
        impl Drop for Pending<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
                if !self.2 {
                    self.1.send_replace(true);
                }
            }
        }
        let mut pending = Pending(&self.life.busy, &self.life.cancel, false);
        let (send, recv) = oneshot::channel();
        let result = if self.life.requests.try_send(send).is_err() {
            self.life
                .terminal
                .borrow()
                .clone()
                .unwrap_or_else(|| Err(error(ErrorCode::OwnerUnavailable, "stream closed")))
                .map(|_| None)
        } else {
            recv.await
                .unwrap_or_else(|_| Err(error(ErrorCode::OwnerUnavailable, "stream closed")))
        };
        pending.2 = true;
        result
    }
}
pub(crate) struct Admission {
    pub cancel: watch::Sender<bool>,
    pub caller: String,
    pub owner: u64,
}
pub(crate) type Admissions = std::sync::Mutex<Vec<Weak<Admission>>>;

pub(crate) fn start(
    mut source: ByteStream,
    policy: StreamPolicy,
    caller: String,
    owner: Owner,
    admission: Arc<Admission>,
) -> StreamHandle {
    let (requests, mut receiver) = mpsc::channel::<Request>(1);
    let (cancel, mut cancelled) = watch::channel(false);
    let (terminal, _) = watch::channel(None);
    let life = Arc::new(Life {
        caller,
        cancel,
        terminal: terminal.clone(),
        busy: AtomicBool::new(false),
        requests,
    });
    let mut closed = owner.closed.subscribe();
    tokio::spawn(async move {
        let _admission = admission;
        let _owner = owner;
        let total = async {
            if policy.total_ms == 0 {
                std::future::pending::<()>().await;
            }
            tokio::time::sleep(Duration::from_millis(policy.total_ms)).await;
        };
        tokio::pin!(total);
        let mut pending: Option<Request> = None;
        loop {
            let work = async {
                let request = tokio::time::timeout(Duration::from_millis(policy.consumer_idle_ms), receiver.recv())
                    .await
                    .map_err(|_| error(ErrorCode::Timeout, "consumer idle timed out"))?
                    .ok_or_else(|| error(ErrorCode::Cancelled, "stream dropped"))?;
                pending = Some(request);
                let item = tokio::time::timeout(
                    Duration::from_millis(policy.producer_idle_ms),
                    std::panic::AssertUnwindSafe(source.next()).catch_unwind(),
                )
                .await
                .map_err(|_| error(ErrorCode::Timeout, "producer idle timed out"))?
                .map_err(|_| error(ErrorCode::HandlerError, "stream producer panicked"))?;
                match item {
                    None => Ok(None),
                    Some(Err(error)) => Err(error),
                    Some(Ok(bytes)) if bytes.len() > policy.max_chunk_bytes => {
                        Err(error(ErrorCode::ResourceExhausted, "chunk too large"))
                    }
                    Some(Ok(bytes)) => Ok(Some(bytes)),
                }
            };
            let item = tokio::select! {
                biased;
                _ = async { if !*cancelled.borrow() { let _ = cancelled.changed().await; } } =>
                    Err(error(ErrorCode::Cancelled, "stream cancelled")),
                _ = async { if !*closed.borrow() { let _ = closed.changed().await; } } =>
                    Err(error(ErrorCode::OwnerUnavailable, "owner closed")),
                _ = &mut total => Err(error(ErrorCode::Timeout, "stream total timed out")),
                result = work => result,
            };
            let done = !matches!(&item, Ok(Some(_)));
            let terminal_result = item.as_ref().map(|_| ()).map_err(Clone::clone);
            if done {
                drop(source);
                drop(_admission);
                terminal.send_replace(Some(terminal_result));
                if let Some(request) = pending.take() {
                    let _ = request.send(item);
                }
                return;
            }
            if let Some(request) = pending.take() {
                let _ = request.send(item);
            }
        }
    });
    StreamHandle { life }
}

/// Owned Stream adapter: dropping it releases the final handle and cancels the actor.
pub struct ResponseStream {
    handle: StreamHandle,
    pending: Option<Pin<Box<dyn Future<Output = Item> + Send>>>,
    ended: bool,
}
impl ResponseStream {
    pub fn new(handle: StreamHandle) -> Self {
        Self {
            handle,
            pending: None,
            ended: false,
        }
    }
    pub fn cancel_handle(&self) -> StreamHandle {
        self.handle.clone()
    }
    pub async fn cancel(&self) -> Result<(), GatewayError> {
        self.handle.cancel().await
    }
}
impl Stream for ResponseStream {
    type Item = Result<Vec<u8>, GatewayError>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.ended {
            return Poll::Ready(None);
        }
        if self.pending.is_none() {
            let handle = self.handle.clone();
            self.pending = Some(Box::pin(async move { handle.next().await }));
        }
        match self.pending.as_mut().unwrap().as_mut().poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(item) => {
                self.pending = None;
                match item {
                    Ok(Some(bytes)) => Poll::Ready(Some(Ok(bytes))),
                    Ok(None) => {
                        self.ended = true;
                        Poll::Ready(None)
                    }
                    Err(error) => {
                        self.ended = true;
                        Poll::Ready(Some(Err(error)))
                    }
                }
            }
        }
    }
}
impl Drop for ResponseStream {
    fn drop(&mut self) {
        self.handle.cancel_now();
    }
}

pub fn encode_frame(seq: u32, item: Option<Vec<u8>>) -> Vec<u8> {
    match item {
        None => vec![0],
        Some(bytes) => {
            let mut frame = vec![1];
            frame.extend(seq.to_be_bytes());
            frame.extend(bytes);
            frame
        }
    }
}
pub fn decode_frame(bytes: Vec<u8>, seq: u32) -> Item {
    if bytes == [0] {
        return Ok(None);
    }
    if bytes.len() < 5 || bytes[0] != 1 || bytes[1..5] != seq.to_be_bytes() {
        return Err(error(ErrorCode::Incompatible, "invalid stream sequence or frame"));
    }
    Ok(Some(bytes[5..].to_vec()))
}

/// A single producer owns Sender and must await send; the queue accounts encoded PB bytes.
/// In addition to the queue, at most one chunk is held by send and one by the consumer.
pub struct ByteSender {
    sender: mpsc::Sender<(Vec<u8>, tokio::sync::OwnedSemaphorePermit)>,
    bytes: Arc<tokio::sync::Semaphore>,
    failed: watch::Sender<Option<GatewayError>>,
    max_chunk: usize,
}
impl ByteSender {
    pub async fn send(&mut self, bytes: Vec<u8>) -> Result<(), GatewayError> {
        if bytes.len() > self.max_chunk {
            let error = error(ErrorCode::ResourceExhausted, "chunk exceeds queue policy");
            self.failed.send_replace(Some(error.clone()));
            return Err(error);
        }
        let permit = tokio::select! {
            _ = self.sender.closed() => return Err(error(ErrorCode::Cancelled, "queue closed")),
            permit = self.bytes.clone().acquire_many_owned(bytes.len() as u32) =>
                permit.map_err(|_| error(ErrorCode::Cancelled, "queue closed"))?,
        };
        self.sender
            .send((bytes, permit))
            .await
            .map_err(|_| error(ErrorCode::Cancelled, "queue closed"))
    }
}
pub fn bounded_byte_queue(policy: &StreamPolicy) -> Result<(ByteSender, ByteStream), GatewayError> {
    policy.validate()?;
    let (sender, receiver) = mpsc::channel::<(Vec<u8>, tokio::sync::OwnedSemaphorePermit)>(policy.queue_items);
    let bytes = Arc::new(tokio::sync::Semaphore::new(policy.queue_bytes));
    let (failed, failure) = watch::channel(None);
    let stream = futures_util::stream::try_unfold((receiver, failure), |(mut receiver, mut failure)| async move {
        let result = tokio::select! {
            biased;
            _ = async { if failure.borrow().is_none() { let _ = failure.changed().await; } } => {
                let error = failure.borrow().clone();
                if let Some(error) = error { return Err(error); }
                receiver.recv().await
            }
            item = receiver.recv() => item,
        };
        Ok(result.map(|(bytes, permit)| {
            drop(permit);
            (bytes, (receiver, failure))
        }))
    });
    Ok((
        ByteSender {
            sender,
            bytes,
            failed,
            max_chunk: policy.max_chunk_bytes.min(policy.queue_bytes),
        },
        Box::pin(stream),
    ))
}
