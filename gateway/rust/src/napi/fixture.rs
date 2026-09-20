//! Compiled only into explicit integration-test builds. No product routes/data.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{Notify, mpsc};
use xw_contracts::testing::{Changed, Envelope};

use super::Endpoint;
use crate::event::{EventBackpressure, EventExportRegistration, EventSubscription};
use crate::{ErrorCode, GatewayError, InvokeRegistration, MethodKind, XwInvokeRegistry};

#[path = "../../tests/fixture_bindings.rs"]
mod bindings;

pub struct Fixture {
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
        let owner = registry
            .register_owner(
                "fixture",
                vec![registration, InvokeRegistration::stream(watch.route())],
                events,
            )
            .expect("valid fixture manifest");
        let (sender, received) = mpsc::unbounded_channel();
        Self {
            endpoint: Endpoint::new(registry, owner),
            release,
            subscriptions: Mutex::new(vec![]),
            received: tokio::sync::Mutex::new(received),
            sender,
        }
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
