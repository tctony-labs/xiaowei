//! Regression cases migrated from xw-tauri invoke.rs/event.rs, using PB contracts
//! and injected sinks in place of JSON, Tauri windows and socket epochs.
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use prost::Message;
use tokio::sync::{Notify, mpsc};
use xw_contracts::testing::{Changed, Envelope};
use xw_gateway::{
    binding::Method,
    event::{EventBackpressure, EventExportRegistration},
    *,
};

#[allow(dead_code)]
mod fixture_bindings;
use fixture_bindings::testing_fixture_service::{ECHO, WATCH};
fn context() -> CallContext {
    CallContext::trusted("test")
}
fn bytes(id: u64) -> Vec<u8> {
    Envelope {
        id,
        ..Default::default()
    }
    .encode_to_vec()
}
fn export(policy: EventBackpressure) -> EventExportRegistration {
    EventExportRegistration::typed::<Changed, Envelope, _>(policy, |payload, filter| {
        filter.is_none_or(|f| payload.value.as_ref().is_some_and(|p| p.id >= f.id))
    })
}
fn changed(id: u64) -> Vec<u8> {
    Changed {
        value: Some(Envelope {
            id,
            ..Default::default()
        }),
    }
    .encode_to_vec()
}

#[tokio::test]
async fn register_owner_is_atomic_and_unregisters_as_a_group() {
    let registry = XwInvokeRegistry::new();
    let old = registry
        .register_owner("owner-a", vec![ECHO.handler(|p, _| async { Ok(p) })], vec![])
        .unwrap();
    let conflict = registry.register_owner("owner-b", vec![ECHO.handler(|p, _| async { Ok(p) })], vec![]);
    assert_eq!(conflict.err().unwrap().code, ErrorCode::Conflict);
    let duplicate = registry.register_owner(
        "owner-a",
        vec![
            ECHO.handler(|p, _| async { Ok(p) }),
            ECHO.handler(|p, _| async { Ok(p) }),
        ],
        vec![],
    );
    assert_eq!(duplicate.err().unwrap().code, ErrorCode::Conflict);
    assert!(!old.is_closed());
    assert_eq!(registry.snapshot_routes(), [ECHO.route()]);
    let next = registry
        .register_owner("owner-a", vec![ECHO.handler(|p, _| async { Ok(p) })], vec![])
        .unwrap();
    assert_ne!(old.instance(), next.instance());
    registry.unregister_owner(&old);
    assert_eq!(
        ECHO.call(&registry.client(context()), Envelope::default())
            .await
            .unwrap(),
        Envelope::default()
    );
    registry.unregister_owner(&next);
    assert!(registry.snapshot_routes().is_empty());
    assert_eq!(
        registry
            .call(&ECHO.route(), bytes(1), context())
            .await
            .unwrap_err()
            .code,
        ErrorCode::UnknownRoute
    );
}

#[tokio::test]
async fn typed_adapter_enforces_payload() {
    let registry = XwInvokeRegistry::new();
    registry
        .register_owner("owner", vec![ECHO.handler(|p, _| async { Ok(p) })], vec![])
        .unwrap();
    let client = registry.client(context());
    let payload = Envelope {
        text: "测试🦀".into(),
        id: u64::MAX,
        label: Some(String::new()),
        blobs: vec![xw_contracts::testing::envelope::Blob { data: vec![0, 255, 1] }],
        value: Some(xw_contracts::testing::envelope::Value::NullValue(0)),
    };
    assert_eq!(ECHO.call(&client, payload.clone()).await.unwrap(), payload);
    assert_eq!(
        client.invoke(&ECHO.route(), vec![0xff]).await.unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    assert_eq!(binding::parse_id("18446744073709551615").unwrap(), u64::MAX);
    for id in ["-1", "+1", "1.0", "18446744073709551616", ""] {
        assert!(binding::parse_id(id).is_err());
    }
}

#[tokio::test]
async fn unknown_route_uses_remote_invoker() {
    let registry = XwInvokeRegistry::new();
    let remote = XwInvokeRegistry::new();
    let owner = remote
        .register_owner("remote", vec![ECHO.handler(|p, _| async { Ok(p) })], vec![])
        .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    registry.set_remote_invoker(move |route, payload, context| {
        calls.fetch_add(1, Ordering::SeqCst);
        let remote = remote.clone();
        let owner = owner.clone();
        async move { remote.dispatch_local(&owner, &route, payload, context).await }
    });
    assert_eq!(
        registry.call(&ECHO.route(), bytes(42), context()).await.unwrap(),
        bytes(42)
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
    registry
        .register_owner("local", vec![ECHO.handler(|p, _| async { Ok(p) })], vec![])
        .unwrap();
    registry.call(&ECHO.route(), bytes(43), context()).await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let mut missing = ECHO.route();
    missing.name = "testing.Missing".into();
    assert_eq!(
        registry.call(&missing, vec![], context()).await.unwrap_err().code,
        ErrorCode::UnknownRoute
    );
    assert_eq!(count.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn concurrency_limit_rejects_excess_calls_and_timeout_retains_admission() {
    let registry = XwInvokeRegistry::new();
    let release = Arc::new(Notify::new());
    let release_handler = release.clone();
    let mut registration = ECHO.handler(move |p, _| {
        let release = release_handler.clone();
        async move {
            // Models an awaited, non-abortable OS/database task.
            release.notified().await;
            Ok(p)
        }
    });
    registration.max_concurrency = 1;
    registration.timeout = Duration::from_millis(10);
    registry.register_owner("owner", vec![registration], vec![]).unwrap();
    assert_eq!(
        registry
            .call(&ECHO.route(), bytes(1), context())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Timeout
    );
    for _ in 0..10 {
        assert_eq!(
            registry
                .call(&ECHO.route(), bytes(1), context())
                .await
                .unwrap_err()
                .code,
            ErrorCode::ConcurrencyFull
        );
    }
    release.notify_one();
    tokio::task::yield_now().await;
    release.notify_one();
    registry.call(&ECHO.route(), bytes(1), context()).await.unwrap();
}

#[tokio::test]
async fn pending_owner_close_rejects_and_old_results_cannot_complete_new_instance() {
    let registry = XwInvokeRegistry::new();
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let signal = started.clone();
    let gate = release.clone();
    let old = registry
        .register_owner(
            "owner",
            vec![ECHO.handler(move |p, _| {
                let signal = signal.clone();
                let gate = gate.clone();
                async move {
                    signal.notify_one();
                    gate.notified().await;
                    Ok(p)
                }
            })],
            vec![],
        )
        .unwrap();
    let caller = registry.clone();
    let pending = tokio::spawn(async move { caller.call(&ECHO.route(), bytes(1), context()).await });
    started.notified().await;
    let next = registry
        .register_owner("owner", vec![ECHO.handler(|p, _| async { Ok(p) })], vec![])
        .unwrap();
    assert_eq!(pending.await.unwrap().unwrap_err().code, ErrorCode::OwnerUnavailable);
    release.notify_one();
    registry.unregister_owner(&old);
    assert_eq!(
        registry
            .dispatch_local(&old, &ECHO.route(), bytes(2), context())
            .await
            .unwrap_err()
            .code,
        ErrorCode::OwnerUnavailable
    );
    assert_eq!(
        registry
            .dispatch_local(&next, &ECHO.route(), bytes(3), context())
            .await
            .unwrap(),
        bytes(3)
    );
}

#[tokio::test]
async fn kind_version_panics_and_nested_permissions() {
    let registry = XwInvokeRegistry::new();
    registry
        .register_owner(
            "owner",
            vec![
                ECHO.handler(|_, _| async { panic!("handler failed") }),
                InvokeRegistration::stream(WATCH.route()),
            ],
            vec![],
        )
        .unwrap();
    assert_eq!(
        registry
            .call(&ECHO.route(), bytes(1), context())
            .await
            .unwrap_err()
            .code,
        ErrorCode::HandlerError
    );
    assert_eq!(
        registry
            .call(&WATCH.route(), bytes(1), context())
            .await
            .unwrap_err()
            .code,
        ErrorCode::WrongMethodKind
    );
    let mut incompatible = ECHO.route();
    incompatible.control_version = 2;
    assert_eq!(
        registry
            .call(&incompatible, bytes(1), context())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Incompatible
    );
    let nested = Method::<Envelope, Envelope>::new("testing.Nested", MethodKind::Unary);
    registry
        .register_owner(
            "owner",
            vec![
                ECHO.handler(move |p, client| async move {
                    let nested = Method::<Envelope, Envelope>::new("testing.Nested", MethodKind::Unary);
                    nested.call(&client, p).await
                }),
                nested.handler(|p, _| async { Ok(p) }),
            ],
            vec![],
        )
        .unwrap();
    let restricted = CallContext::restricted("plugin", vec![ECHO.name.into()], vec![]);
    assert_eq!(
        registry
            .call(&ECHO.route(), bytes(1), restricted)
            .await
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    registry.call(&ECHO.route(), bytes(1), context()).await.unwrap();
}

#[tokio::test]
async fn owner_registration_is_atomic_and_has_snapshots() {
    let registry = XwInvokeRegistry::new();
    let owner = registry
        .register_owner("a", vec![], vec![export(EventBackpressure::Coalesce)])
        .unwrap();
    let conflict = registry.register_owner(
        "b",
        vec![ECHO.handler(|p, _| async { Ok(p) })],
        vec![export(EventBackpressure::Ordered)],
    );
    assert_eq!(conflict.err().unwrap().code, ErrorCode::Conflict);
    assert!(registry.snapshot_routes().is_empty());
    assert_eq!(
        registry.snapshot_events(),
        [("testing.Changed".into(), EventBackpressure::Coalesce)]
    );
    registry.unregister_owner(&owner);
    assert!(registry.snapshot_events().is_empty());
}

#[tokio::test]
async fn typed_filter_is_checked_and_subscriptions_are_authorized() {
    let registry = XwInvokeRegistry::new();
    let owner = registry
        .register_owner("owner", vec![], vec![export(EventBackpressure::Ordered)])
        .unwrap();
    assert!(
        registry
            .subscribe(&context(), "testing.Changed", Some(vec![0xff]), false, |_| async {})
            .is_err()
    );
    let denied = CallContext::restricted("plugin", vec![], vec![]);
    assert!(
        registry
            .subscribe(&denied, "testing.Changed", None, true, |_| async {})
            .is_err()
    );
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = registry
        .subscribe(&context(), "testing.Changed", Some(bytes(2)), false, move |p| {
            tx.send(p).unwrap();
            async {}
        })
        .unwrap();
    registry.publish(&owner, "testing.Changed", changed(1)).unwrap();
    registry.publish(&owner, "testing.Changed", changed(2)).unwrap();
    assert_eq!(rx.recv().await.unwrap(), changed(2));
    handle.close();
    handle.close();
    assert!(registry.publish(&owner, "testing.Unexported", vec![]).is_err());
}

#[tokio::test]
async fn events_can_be_published_from_a_thread_without_a_runtime() {
    let registry = XwInvokeRegistry::new();
    let owner = registry
        .register_owner("owner", vec![], vec![export(EventBackpressure::Ordered)])
        .unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let _handle = registry
        .subscribe(&context(), "testing.Changed", None, false, move |payload| {
            let tx = tx.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(1)).await;
                tx.send(payload).unwrap();
            }
        })
        .unwrap();
    std::thread::spawn(move || {
        assert!(tokio::runtime::Handle::try_current().is_err());
        for id in 0..3 {
            registry.publish(&owner, "testing.Changed", changed(id)).unwrap();
        }
    })
    .join()
    .unwrap();
    for id in 0..3 {
        let payload = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.unwrap();
        assert_eq!(payload.unwrap(), changed(id));
    }
}

#[tokio::test]
async fn remote_events_can_be_delivered_from_a_thread_without_a_runtime() {
    use xw_gateway::event::{EventSink, EventTransport, RemoteBinding, RemoteEvents};
    let events = RemoteEvents::default();
    let (deliver, mut delivery) = mpsc::unbounded_channel::<EventSink>();
    let transport: EventTransport = Arc::new(move |_, _, _, sink| {
        deliver.send(sink).unwrap();
        Box::pin(async {
            Ok(RemoteBinding {
                policy: EventBackpressure::Ordered,
                close: Arc::new(|| {}),
            })
        })
    });
    events.set_transport(Some(transport)).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let _handle = events
        .subscribe(context(), "testing.Changed", None, false, move |payload| {
            let tx = tx.clone();
            async move { tx.send(payload).unwrap() }
        })
        .await
        .unwrap();
    let sink = delivery.recv().await.unwrap();
    std::thread::spawn(move || {
        assert!(tokio::runtime::Handle::try_current().is_err());
        sink(changed(42));
    })
    .join()
    .unwrap();
    let payload = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.unwrap();
    assert_eq!(payload.unwrap(), changed(42));
}

#[tokio::test]
async fn ordered_delivery_preserves_bursts_larger_than_legacy_capacity() {
    let registry = XwInvokeRegistry::new();
    let owner = registry
        .register_owner("owner", vec![], vec![export(EventBackpressure::Ordered)])
        .unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let _handle = registry
        .subscribe(&context(), "testing.Changed", None, false, move |p| {
            tx.send(p).unwrap();
            async {}
        })
        .unwrap();
    for id in 0..256 {
        registry.publish(&owner, "testing.Changed", changed(id)).unwrap();
    }
    for id in 0..256 {
        assert_eq!(rx.recv().await.unwrap(), changed(id));
    }
}

#[tokio::test]
async fn coalesce_keeps_last_and_drop_keeps_first_pending() {
    for (policy, expected) in [(EventBackpressure::Coalesce, 255), (EventBackpressure::Drop, 0)] {
        let registry = XwInvokeRegistry::new();
        let owner = registry.register_owner("owner", vec![], vec![export(policy)]).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _handle = registry
            .subscribe(&context(), "testing.Changed", None, false, move |p| {
                tx.send(p).unwrap();
                async {}
            })
            .unwrap();
        for id in 0..256 {
            registry.publish(&owner, "testing.Changed", changed(id)).unwrap();
        }
        assert_eq!(rx.recv().await.unwrap(), changed(expected));
        assert!(rx.try_recv().is_err());
    }
}

#[tokio::test]
async fn backend_subscription_is_retained_while_owner_is_unavailable_and_stale_delivery_rejected() {
    let registry = XwInvokeRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let subscription = registry
        .subscribe(&context(), "testing.Changed", None, true, move |p| {
            tx.send(p).unwrap();
            async {}
        })
        .unwrap();
    let old = registry
        .register_owner("owner", vec![], vec![export(EventBackpressure::Ordered)])
        .unwrap();
    registry.publish(&old, "testing.Changed", changed(1)).unwrap();
    assert_eq!(rx.recv().await.unwrap(), changed(1));
    registry.unregister_owner(&old);
    let next = registry
        .register_owner("owner", vec![], vec![export(EventBackpressure::Ordered)])
        .unwrap();
    assert_eq!(
        registry.publish(&old, "testing.Changed", changed(2)).unwrap_err().code,
        ErrorCode::OwnerUnavailable
    );
    registry.publish(&next, "testing.Changed", changed(3)).unwrap();
    assert_eq!(rx.recv().await.unwrap(), changed(3));
    subscription.close();
    registry.publish(&next, "testing.Changed", changed(4)).unwrap();
    assert!(rx.recv().await.is_none());
}

#[tokio::test]
async fn unregistering_owner_removes_its_source_subscriptions_and_caller_cleanup_removes_pending() {
    let registry = XwInvokeRegistry::new();
    let owner = registry
        .register_owner("owner", vec![], vec![export(EventBackpressure::Ordered)])
        .unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let _subscription = registry
        .subscribe(&context(), "testing.Changed", None, false, move |p| {
            tx.send(p).unwrap();
            async {}
        })
        .unwrap();
    registry.unregister_owner(&owner);
    assert!(rx.recv().await.is_none());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let _subscription = registry
        .subscribe(&context(), "testing.Changed", None, true, move |p| {
            tx.send(p).unwrap();
            async {}
        })
        .unwrap();
    registry.cleanup_caller("test");
    assert!(rx.recv().await.is_none());
}

#[tokio::test]
async fn backend_remote_subscription_receives_typed_delivery_and_rejects_stale_connection() {
    use xw_gateway::event::{EventTransport, RemoteBinding};
    let source = XwInvokeRegistry::new();
    let receiver = XwInvokeRegistry::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let subscription = receiver
        .client(context())
        .subscribe("testing.Changed", None, true, move |p| {
            tx.send(p).unwrap();
            async {}
        })
        .await
        .unwrap();
    let endpoint = source.clone();
    let transport: EventTransport = Arc::new(move |context, name, filter, sink| {
        let endpoint = endpoint.clone();
        Box::pin(async move {
            let handle = endpoint.subscribe(&context, &name, filter, true, move |p| {
                sink(p);
                async {}
            })?;
            Ok(RemoteBinding {
                policy: EventBackpressure::Ordered,
                close: Arc::new(move || handle.close()),
            })
        })
    });
    receiver.remote_events.set_transport(Some(transport.clone())).await;
    let owner = source
        .register_owner("source", vec![], vec![export(EventBackpressure::Ordered)])
        .unwrap();
    source.publish(&owner, "testing.Changed", changed(42)).unwrap();
    assert_eq!(rx.recv().await.unwrap(), changed(42));
    receiver.remote_events.set_transport(None).await;
    source.publish(&owner, "testing.Changed", changed(43)).unwrap();
    receiver.remote_events.set_transport(Some(transport)).await;
    source.publish(&owner, "testing.Changed", changed(44)).unwrap();
    assert_eq!(rx.recv().await.unwrap(), changed(44));
    subscription.close();
    subscription.close();
    assert!(rx.recv().await.is_none());
}

#[tokio::test]
async fn unsubscribe_backend_removes_pending_remote_subscription_and_closes_late_binding() {
    use xw_gateway::event::{EventTransport, RemoteBinding};
    let registry = XwInvokeRegistry::new();
    let release = Arc::new(Notify::new());
    let started = Arc::new(Notify::new());
    let count = Arc::new(AtomicUsize::new(0));
    let gate = release.clone();
    let signal = started.clone();
    let closed = count.clone();
    let transport: EventTransport = Arc::new(move |_, _, _, _| {
        let gate = gate.clone();
        let signal = signal.clone();
        let closed = closed.clone();
        Box::pin(async move {
            signal.notify_one();
            gate.notified().await;
            Ok(RemoteBinding {
                policy: EventBackpressure::Ordered,
                close: Arc::new(move || {
                    closed.fetch_add(1, Ordering::SeqCst);
                }),
            })
        })
    });
    registry.remote_events.set_transport(Some(transport)).await;
    let caller = registry.client(context());
    let pending = tokio::spawn(async move { caller.subscribe("testing.Changed", None, true, |_| async {}).await });
    started.notified().await;
    registry.cleanup_caller("test");
    release.notify_one();
    pending.await.unwrap().unwrap().close();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn shared_wire_cases_use_the_same_contract_in_both_languages() {
    let cases: serde_json::Value = serde_json::from_str(include_str!("../../tests/wire-cases.json")).unwrap();
    let registry = XwInvokeRegistry::new();
    registry
        .register_owner("fixture", vec![ECHO.handler(|p, _| async { Ok(p) })], vec![])
        .unwrap();
    for case in cases.as_array().unwrap() {
        let payload: Vec<u8> = serde_json::from_value(case["payload"].clone()).unwrap();
        let result = registry.call(&ECHO.route(), payload, context()).await;
        if case["valid"] == true {
            let response = Envelope::decode(result.unwrap().as_slice()).unwrap();
            assert_eq!(response.id.to_string(), case["id"].as_str().unwrap());
        } else {
            assert_eq!(result.unwrap_err().code, ErrorCode::InvalidArgument);
        }
    }
}

#[tokio::test]
async fn blocking_task_keeps_its_slot_after_timeout() {
    let registry = XwInvokeRegistry::new();
    let (release, gate) = std::sync::mpsc::channel();
    let gate = Arc::new(std::sync::Mutex::new(gate));
    let mut registration = ECHO.handler(move |p, _| {
        let gate = gate.clone();
        async move {
            tokio::task::spawn_blocking(move || gate.lock().unwrap().recv().unwrap())
                .await
                .unwrap();
            Ok(p)
        }
    });
    registration.max_concurrency = 1;
    registration.timeout = Duration::from_millis(10);
    registry.register_owner("blocking", vec![registration], vec![]).unwrap();
    assert_eq!(
        registry
            .call(&ECHO.route(), bytes(1), context())
            .await
            .unwrap_err()
            .code,
        ErrorCode::Timeout
    );
    assert_eq!(
        registry
            .call(&ECHO.route(), bytes(1), context())
            .await
            .unwrap_err()
            .code,
        ErrorCode::ConcurrencyFull
    );
    release.send(()).unwrap();
}

#[tokio::test]
async fn old_remote_subscribe_failure_cannot_remove_new_connection_binding() {
    use xw_gateway::event::{EventTransport, RemoteBinding};
    let registry = XwInvokeRegistry::new();
    let release = Arc::new(Notify::new());
    let started = Arc::new(Notify::new());
    let gate = release.clone();
    let signal = started.clone();
    let old: EventTransport = Arc::new(move |_, _, _, _| {
        let gate = gate.clone();
        let signal = signal.clone();
        Box::pin(async move {
            signal.notify_one();
            gate.notified().await;
            Err(GatewayError::new(ErrorCode::OwnerUnavailable, "old transport closed"))
        })
    });
    registry.remote_events.set_transport(Some(old)).await;
    let client = registry.client(context());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let pending = tokio::spawn(async move {
        client
            .subscribe("testing.Changed", None, true, move |p| {
                tx.send(p).unwrap();
                async {}
            })
            .await
    });
    started.notified().await;
    let delivery = Arc::new(std::sync::Mutex::new(None::<xw_gateway::event::EventSink>));
    let target = delivery.clone();
    let next: EventTransport = Arc::new(move |_, _, _, sink| {
        *target.lock().unwrap() = Some(sink);
        Box::pin(async {
            Ok(RemoteBinding {
                policy: EventBackpressure::Ordered,
                close: Arc::new(|| {}),
            })
        })
    });
    registry.remote_events.set_transport(Some(next)).await;
    release.notify_one();
    let subscription = pending.await.unwrap().unwrap();
    delivery.lock().unwrap().as_ref().unwrap()(changed(1));
    assert_eq!(rx.recv().await.unwrap(), changed(1));
    subscription.close();
}

#[tokio::test]
async fn manifest_retains_execution_defaults_and_foreign_handles_cannot_address_an_owner() {
    let registry = XwInvokeRegistry::new();
    let owner = registry
        .register_owner(
            "a",
            vec![ECHO.handler(|p, _| async { Ok(p) })],
            vec![export(EventBackpressure::Ordered)],
        )
        .unwrap();
    let manifest = registry.manifest(&owner).unwrap();
    assert_eq!(manifest.routes[0].timeout_ms, 30_000);
    assert_eq!(manifest.routes[0].max_concurrency, 32);
    assert_eq!(manifest.events[0].name, "testing.Changed");
    let other = XwInvokeRegistry::new();
    let foreign = other.register_owner("a", vec![], vec![]).unwrap();
    registry.unregister_owner(&foreign);
    assert_eq!(
        registry
            .dispatch_local(&foreign, &ECHO.route(), bytes(1), context())
            .await
            .unwrap_err()
            .code,
        ErrorCode::OwnerUnavailable
    );
    registry.call(&ECHO.route(), bytes(1), context()).await.unwrap();
}
