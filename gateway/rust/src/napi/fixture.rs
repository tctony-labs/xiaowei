//! Compiled only into explicit integration-test builds. No product routes/data.
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use tokio::sync::{Notify, mpsc};
use xw_contracts::testing::{Changed, Envelope};

use super::Endpoint;
use crate::event::{EventBackpressure, EventExportRegistration, EventSubscription};
use crate::{ErrorCode, GatewayError, MethodKind, XwInvokeRegistry};
use futures_util::StreamExt;

#[path = "../../tests/fixture_bindings.rs"]
mod bindings;

#[derive(Default)]
struct StreamUsage {
    active: AtomicUsize,
    polls: AtomicUsize,
}
struct StreamGuard(Arc<StreamUsage>);
impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}
pub struct Fixture {
    stream_usage: Arc<StreamUsage>,
    pub endpoint: Arc<Endpoint>,
    release: Arc<Notify>,
    subscriptions: Mutex<Vec<EventSubscription>>,
    received: tokio::sync::Mutex<mpsc::UnboundedReceiver<Vec<u8>>>,
    sender: mpsc::UnboundedSender<Vec<u8>>,
}

impl Fixture {
    pub fn new(peer: bool) -> Self {
        let registry = XwInvokeRegistry::new();
        let release = Arc::new(Notify::new());
        let gate = release.clone();
        let method = if peer {
            &bindings::testing_peer_fixture_service::ECHO
        } else {
            &bindings::testing_fixture_service::ECHO
        };
        let other = if peer {
            &bindings::testing_fixture_service::ECHO
        } else {
            &bindings::testing_peer_fixture_service::ECHO
        };
        let mut registration = method.handler(move |mut request, client| {
            let gate = gate.clone();
            async move {
                match request.text.as_str() {
                    "stream-relay" | "stream-local" => {
                        let target = if (request.text == "stream-local") == peer {
                            &bindings::testing_peer_fixture_service::WATCH
                        } else {
                            &bindings::testing_fixture_service::WATCH
                        };
                        request.text = "chunks".into();
                        let mut stream = target.stream(&client, request).await?;
                        let mut result = Envelope::default();
                        while let Some(chunk) = stream.next().await {
                            if let Some(value) = chunk?.value {
                                result = value;
                            }
                        }
                        return Ok(result);
                    }
                    "wait" => gate.notified().await,
                    "fail" => return Err(GatewayError::new(ErrorCode::HandlerError, "fixture failed")),
                    "relay" | "back" | "cycle" => {
                        request.text = match request.text.as_str() {
                            "relay" => "back",
                            "back" => "done",
                            _ => "cycle",
                        }
                        .into();
                        return other.call(&client, request).await;
                    }
                    _ => {}
                }
                Ok(request)
            }
        });
        registration.max_concurrency = 2;
        registration.timeout = Duration::from_millis(100);
        let watch = if peer {
            &bindings::testing_peer_fixture_service::WATCH
        } else {
            &bindings::testing_fixture_service::WATCH
        };
        assert_eq!(watch.kind, MethodKind::ServerStreaming);
        let events = if peer {
            vec![]
        } else {
            vec![EventExportRegistration::typed::<Changed, Envelope, _>(
                EventBackpressure::Ordered,
                |payload, filter| filter.is_none_or(|f| payload.value.as_ref().is_some_and(|p| p.id >= f.id)),
            )]
        };
        let stream_gate = release.clone();
        let stream_usage = Arc::new(StreamUsage::default());
        let usage = stream_usage.clone();
        let stream_registration = watch.handler(move |mut request, client| {
            let gate = stream_gate.clone();
            let usage = usage.clone();
            async move {
                if let Some(text) = request.text.strip_prefix("relay-") {
                    request.text = text.to_string();
                    let target = if peer {
                        &bindings::testing_fixture_service::WATCH
                    } else {
                        &bindings::testing_peer_fixture_service::WATCH
                    };
                    return Ok(Box::pin(target.stream(&client, request).await?)
                        as std::pin::Pin<
                            Box<dyn futures_util::Stream<Item = Result<Changed, GatewayError>> + Send>,
                        >);
                }
                usage.active.fetch_add(1, Ordering::SeqCst);
                let guard = StreamGuard(usage.clone());
                if request.text == "openwait" {
                    gate.notified().await;
                }
                if request.text == "openfail" {
                    return Err(GatewayError::new(ErrorCode::HandlerError, "fixture open failed"));
                }
                Ok(Box::pin(futures_util::stream::try_unfold(
                    (request, 0u64, gate, guard),
                    |(request, index, gate, guard)| async move {
                        guard.0.polls.fetch_add(1, Ordering::SeqCst);
                        if index >= request.id {
                            return Ok(None);
                        }
                        if request.text == "wait" {
                            gate.notified().await;
                        }
                        if request.text == "fail" && index == 1 {
                            return Err(GatewayError::new(ErrorCode::HandlerError, "fixture stream failed"));
                        }
                        let mut value = request.clone();
                        value.id = index;
                        Ok(Some((
                            Changed { value: Some(value) },
                            (request, index + 1, gate, guard),
                        )))
                    },
                ))
                    as std::pin::Pin<
                        Box<dyn futures_util::Stream<Item = Result<Changed, GatewayError>> + Send>,
                    >)
            }
        });
        let owner = registry
            .register_owner("fixture", vec![registration, stream_registration], events)
            .expect("valid fixture manifest");
        let (sender, received) = mpsc::unbounded_channel();
        Self {
            endpoint: Endpoint::new(registry, owner),
            stream_usage,
            release,
            subscriptions: Mutex::new(vec![]),
            received: tokio::sync::Mutex::new(received),
            sender,
        }
    }
    pub fn stream_usage(&self) -> String {
        serde_json::json!({ "active": self.stream_usage.active.load(Ordering::SeqCst),
            "polls": self.stream_usage.polls.load(Ordering::SeqCst) })
        .to_string()
    }
    pub fn release(&self) {
        self.release.notify_one();
    }
    pub fn publish(&self, payload: Vec<u8>) -> super::WireResult {
        self.endpoint.ready()?;
        self.endpoint
            .registry
            .publish(&self.endpoint.owner, "testing.Changed", payload)?;
        Ok(vec![])
    }
    pub async fn subscribe(&self, filter: Option<Vec<u8>>) -> super::WireResult {
        self.endpoint.ready()?;
        let origin = self
            .endpoint
            .state
            .lock()
            .unwrap()
            .origin
            .clone()
            .ok_or_else(super::unavailable)?;
        let sender = self.sender.clone();
        let subscription = self
            .endpoint
            .registry
            .client(origin.core())
            .subscribe("testing.Changed", filter, true, move |payload| {
                let _ = sender.send(payload);
                async {}
            })
            .await?;
        self.subscriptions.lock().unwrap().push(subscription);
        Ok(vec![])
    }
    pub fn unsubscribe(&self) {
        self.subscriptions.lock().unwrap().clear();
    }
    pub async fn next(&self) -> super::WireResult {
        tokio::time::timeout(Duration::from_secs(1), self.received.lock().await.recv())
            .await
            .map_err(|_| GatewayError::new(ErrorCode::Timeout, "fixture event timed out"))?
            .ok_or_else(super::unavailable)
    }
}
