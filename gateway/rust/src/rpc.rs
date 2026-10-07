//! Local unary result ownership and cooperative cancellation.
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use tokio::sync::{oneshot, watch};

use crate::{ErrorCode, GatewayError};

struct State {
    pending: Mutex<bool>,
    cancelled: watch::Sender<bool>,
}

#[derive(Clone)]
pub struct CancelHandle(Arc<State>);

pub(crate) struct WeakCancelHandle(std::sync::Weak<State>);

impl WeakCancelHandle {
    pub fn upgrade(&self) -> Option<CancelHandle> {
        self.0.upgrade().map(CancelHandle)
    }
}

impl Default for CancelHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelHandle {
    pub fn new() -> Self {
        Self(Arc::new(State {
            pending: Mutex::new(true),
            cancelled: watch::channel(false).0,
        }))
    }

    pub(crate) fn downgrade(&self) -> WeakCancelHandle {
        WeakCancelHandle(Arc::downgrade(&self.0))
    }

    /// Accepts local cancellation synchronously; does not wait for remote cleanup.
    pub fn cancel(&self) {
        let mut pending = self.0.pending.lock().unwrap();
        if !*pending {
            return;
        }
        *pending = false;
        self.0.cancelled.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.0.cancelled.borrow()
    }

    pub async fn cancelled(&self) {
        let mut receiver = self.0.cancelled.subscribe();
        while !*receiver.borrow() {
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

pub(crate) struct CancelOnDrop(pub CancelHandle);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

pub fn cancelled() -> GatewayError {
    GatewayError::new(ErrorCode::Cancelled, "RPC cancelled")
}

/// Starts on the current Tokio runtime; await and cancellation are independent.
pub struct Rpc<T> {
    result: Pin<Box<dyn Future<Output = Result<T, GatewayError>> + Send>>,
    cancellation: CancelHandle,
}

impl<T: Send + 'static> Rpc<T> {
    pub fn new<F, Fut>(work: F, parent: Option<CancelHandle>) -> Self
    where
        F: FnOnce(CancelHandle) -> Fut + Send + 'static,
        Fut: Future<Output = Result<T, GatewayError>> + Send + 'static,
    {
        let cancellation = CancelHandle::new();
        let task_cancel = cancellation.clone();
        let (sender, receiver) = oneshot::channel();
        tokio::spawn(async move {
            let parent_cancelled = async {
                if let Some(parent) = parent {
                    parent.cancelled().await;
                } else {
                    std::future::pending::<()>().await;
                }
            };
            let result = tokio::select! {
                biased;
                _ = task_cancel.cancelled() => return,
                _ = parent_cancelled => {
                    task_cancel.cancel();
                    return;
                }
                result = work(task_cancel.clone()) => result,
            };
            // Completion and cancel use the same local lock. Await polling cannot change the winner.
            let mut pending = task_cancel.0.pending.lock().unwrap();
            if *pending {
                *pending = false;
                let _ = sender.send(result);
            }
        });
        let waiter_cancel = cancellation.clone();
        Self {
            cancellation,
            result: Box::pin(async move {
                tokio::select! {
                    biased;
                    _ = waiter_cancel.cancelled() => Err(cancelled()),
                    result = receiver => result.unwrap_or_else(|_| {
                        if waiter_cancel.is_cancelled() {
                            Err(cancelled())
                        } else {
                            Err(GatewayError::new(ErrorCode::HandlerError, "RPC task failed"))
                        }
                    }),
                }
            }),
        }
    }

    pub fn cancel_handle(&self) -> CancelHandle {
        self.cancellation.clone()
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub fn map<U, F>(self, decode: F) -> Rpc<U>
    where
        U: Send + 'static,
        F: FnOnce(T) -> Result<U, GatewayError> + Send + 'static,
    {
        Rpc::new(move |_| async move { decode(self.await?) }, None)
    }
}

impl<T> Future for Rpc<T> {
    type Output = Result<T, GatewayError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        self.result.as_mut().poll(cx)
    }
}

impl<T> Drop for Rpc<T> {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}
