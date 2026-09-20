use futures_util::StreamExt;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use xw_contracts::testing::{Changed, Envelope};
use xw_gateway::stream::{StreamPolicy, bounded_byte_queue};
use xw_gateway::{CallContext, ErrorCode, XwInvokeRegistry};
#[allow(dead_code)]
mod fixture_bindings;
use fixture_bindings::testing_fixture_service::WATCH;

#[tokio::test]
async fn typed_local_pull_drop_owner_and_errors() {
    let registry = XwInvokeRegistry::new();
    let polls = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    struct Guard(Arc<AtomicUsize>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let registration = WATCH.handler({
        let polls = polls.clone();
        let dropped = dropped.clone();
        move |request, _| {
            let polls = polls.clone();
            let guard = Guard(dropped.clone());
            async move {
                Ok(futures_util::stream::unfold(
                    (request, guard),
                    move |(request, guard)| {
                        polls.fetch_add(1, Ordering::SeqCst);
                        async move {
                            Some((
                                Ok(Changed {
                                    value: Some(request.clone()),
                                }),
                                (request, guard),
                            ))
                        }
                    },
                ))
            }
        }
    });
    let owner = registry.register_owner("owner", vec![registration], vec![]).unwrap();
    let remote = Arc::new(AtomicUsize::new(0));
    registry.set_remote_stream(Arc::new({
        let remote = remote.clone();
        move |_, _, _| {
            remote.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { panic!("local stream must not forward") })
        }
    }));
    let client = registry.client(CallContext::trusted("test"));
    let input = Envelope {
        id: u64::MAX,
        ..Default::default()
    };
    let mut stream = WATCH.stream(&client, input.clone()).await.unwrap();
    tokio::task::yield_now().await;
    assert_eq!(polls.load(Ordering::SeqCst), 0);
    assert_eq!(stream.next().await.unwrap().unwrap().value, Some(input));
    tokio::task::yield_now().await;
    assert_eq!(polls.load(Ordering::SeqCst), 1);
    drop(stream);
    tokio::task::yield_now().await;
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    let mut stream = WATCH.stream(&client, Envelope::default()).await.unwrap();
    registry.unregister_owner(&owner);
    assert_eq!(
        stream.next().await.unwrap().unwrap_err().code,
        ErrorCode::OwnerUnavailable
    );
    assert_eq!(remote.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn separate_deadlines_admission_and_pending_cancel() {
    let registry = XwInvokeRegistry::new();
    let mut registration = WATCH
        .handler(|_, _| async { Ok(futures_util::stream::pending::<Result<Changed, xw_gateway::GatewayError>>()) });
    registration.stream_policy = StreamPolicy {
        max_caller_streams: 1,
        producer_idle_ms: 20,
        consumer_idle_ms: 100,
        ..Default::default()
    };
    let owner = registry.register_owner("owner", vec![registration], vec![]).unwrap();
    let client = registry.client(CallContext::trusted("test"));
    let mut stream = WATCH.stream(&client, Envelope::default()).await.unwrap();
    assert!(WATCH.stream(&client, Envelope::default()).await.is_err());
    tokio::time::advance(std::time::Duration::from_millis(40)).await;
    // Waiting for the consumer doesn't count toward the 20ms producer timeout.
    let pending = tokio::spawn(async move { stream.next().await });
    tokio::task::yield_now().await;
    tokio::time::advance(std::time::Duration::from_millis(20)).await;
    assert_eq!(pending.await.unwrap().unwrap().unwrap_err().code, ErrorCode::Timeout);
    let mut stream = WATCH.stream(&client, Envelope::default()).await.unwrap();
    let pending = tokio::spawn(async move { stream.next().await });
    tokio::task::yield_now().await;
    registry.cleanup_stream_caller("test");
    assert_eq!(pending.await.unwrap().unwrap().unwrap_err().code, ErrorCode::Cancelled);
    let mut stream = WATCH.stream(&client, Envelope::default()).await.unwrap();
    tokio::task::yield_now().await;
    tokio::time::advance(std::time::Duration::from_millis(100)).await;
    tokio::task::yield_now().await;
    assert_eq!(stream.next().await.unwrap().unwrap_err().code, ErrorCode::Timeout);
    registry.unregister_owner(&owner);
}

#[tokio::test]
async fn bounded_active_queue_waits_and_oversize_cancels() {
    let policy = StreamPolicy {
        queue_items: 1,
        queue_bytes: 2,
        max_chunk_bytes: 2,
        ..Default::default()
    };
    let (mut sender, mut stream) = bounded_byte_queue(&policy).unwrap();
    sender.send(vec![1, 2]).await.unwrap();
    let task = tokio::spawn(async move {
        sender.send(vec![3]).await.unwrap();
        sender
    });
    tokio::task::yield_now().await;
    assert!(!task.is_finished());
    assert_eq!(stream.next().await.unwrap().unwrap(), vec![1, 2]);
    let mut sender = task.await.unwrap();
    assert_eq!(
        sender.send(vec![0; 3]).await.unwrap_err().code,
        ErrorCode::ResourceExhausted
    );
    assert_eq!(
        stream.next().await.unwrap().unwrap_err().code,
        ErrorCode::ResourceExhausted
    );
}

#[tokio::test]
async fn explicit_cancel_interrupts_next_and_releases_admission() {
    let registry = XwInvokeRegistry::new();
    let mut registration = WATCH
        .handler(|_, _| async { Ok(futures_util::stream::pending::<Result<Changed, xw_gateway::GatewayError>>()) });
    registration.stream_policy.max_caller_streams = 1;
    registry.register_owner("owner", vec![registration], vec![]).unwrap();
    let client = registry.client(CallContext::trusted("test"));
    let mut stream = WATCH.stream(&client, Envelope::default()).await.unwrap();
    let handle = stream.cancel_handle();
    let pending = tokio::spawn(async move { stream.next().await });
    tokio::task::yield_now().await;
    assert_eq!(handle.next().await.unwrap_err().code, ErrorCode::ConcurrencyFull);
    handle.cancel().await.unwrap();
    assert_eq!(pending.await.unwrap().unwrap().unwrap_err().code, ErrorCode::Cancelled);
    handle.cancel().await.unwrap();
    let next = WATCH.stream(&client, Envelope::default()).await.unwrap();
    next.cancel().await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn pending_open_caller_cleanup_and_deadline_drop_factory() {
    let registry = XwInvokeRegistry::new();
    let mut registration = WATCH.handler(|_, _| async {
        std::future::pending::<()>().await;
        Ok(futures_util::stream::empty::<Result<Changed, xw_gateway::GatewayError>>())
    });
    registration.stream_policy.open_timeout_ms = 100;
    registration.stream_policy.max_caller_streams = 1;
    registry.register_owner("owner", vec![registration], vec![]).unwrap();
    let client = registry.client(CallContext::trusted("test"));
    let opening = tokio::spawn({
        let client = client.clone();
        async move { WATCH.stream(&client, Envelope::default()).await.err().unwrap() }
    });
    tokio::task::yield_now().await;
    registry.cleanup_stream_caller("test");
    assert_eq!(opening.await.unwrap().code, ErrorCode::Cancelled);
    assert_eq!(
        WATCH.stream(&client, Envelope::default()).await.err().unwrap().code,
        ErrorCode::Timeout
    );
}

#[tokio::test(start_paused = true)]
async fn remote_owner_policy_is_used_without_unary_timeout() {
    let registry = XwInvokeRegistry::new();
    registry.set_remote_stream(Arc::new(|_, _, _| {
        Box::pin(async {
            let source = futures_util::stream::once(async {
                tokio::time::sleep(std::time::Duration::from_secs(70)).await;
                Ok(vec![0; 2 * 1024 * 1024])
            });
            Ok(xw_gateway::stream::RemoteOpen {
                source: Box::pin(source),
                policy: StreamPolicy {
                    max_chunk_bytes: 3 * 1024 * 1024,
                    producer_idle_ms: 80_000,
                    ..Default::default()
                },
            })
        })
    }));
    let client = registry.client(CallContext::trusted("remote"));
    let mut stream = client.stream(&WATCH.route(), vec![]).await.unwrap();
    assert_eq!(stream.next().await.unwrap().unwrap().len(), 2 * 1024 * 1024);
    assert!(stream.next().await.is_none());
}
