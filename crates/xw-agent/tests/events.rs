use futures_util::FutureExt;
mod support;

use std::{sync::Arc, time::Duration};

use support::{create, service};
use tokio::time::timeout;
use xw_agent::{AgentError, EventSubscription, protocol::*};
use xw_agent_types::SessionId;

async fn receive(subscription: &mut EventSubscription) -> AgentEvent {
    timeout(Duration::from_secs(1), subscription.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

async fn snapshot(subscription: &mut EventSubscription) -> AgentSession {
    let Some(agent_event::Payload::SubscriptionReady(ready)) = receive(subscription).await.payload else {
        panic!("first frame must be the initial snapshot");
    };
    ready.session.expect("ready must contain the requested session")
}

#[tokio::test]
async fn observers_of_the_same_session_are_independent() {
    let service = service();
    let session = create(&service);
    let request = SubscribeSessionRequest {
        session_id: session.session_id.clone(),
    };
    let mut a = service
        .subscribe_session(request.clone())
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    let mut b = service
        .subscribe_session(request)
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    assert_eq!(snapshot(&mut a).await, session);
    assert_eq!(snapshot(&mut b).await, session);

    a.close();
    service
        .delete_session(DeleteSessionRequest {
            targets: vec![DeleteSessionTarget {
                session_id: session.session_id.clone(),
                expected_metadata_revision: 1,
                expected_archive_revision: None,
            }],
        })
        .await
        .unwrap();
    assert_eq!(
        receive(&mut b).await.payload,
        Some(agent_event::Payload::SessionDeleted(SessionDeleted {
            session_id: session.session_id,
        }))
    );
    assert_eq!(a.recv().await, None);
}

#[tokio::test]
async fn initial_snapshot_and_later_events_belong_only_to_the_requested_session() {
    let service = service();
    let target = create(&service);
    let existing_other = create(&service);
    let mut observer = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: target.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();

    let _later_other = create(&service);
    for session_id in [existing_other.session_id, target.session_id.clone()] {
        service
            .delete_session(DeleteSessionRequest {
                targets: vec![DeleteSessionTarget {
                    session_id,
                    expected_metadata_revision: 1,
                    expected_archive_revision: None,
                }],
            })
            .await
            .unwrap();
    }

    // Consuming the first frame after mutation cannot change its captured state.
    assert_eq!(snapshot(&mut observer).await, target);
    assert_eq!(
        receive(&mut observer).await.payload,
        Some(agent_event::Payload::SessionDeleted(SessionDeleted {
            session_id: target.session_id,
        }))
    );
}

#[tokio::test]
async fn deletion_racing_subscription_produces_not_found_or_snapshot_then_deletion() {
    for _ in 0..32 {
        let service = Arc::new(service());
        let target = create(&service);
        let result = std::thread::scope(|scope| {
            let subscribe = scope.spawn(|| {
                service
                    .subscribe_session(SubscribeSessionRequest {
                        session_id: target.session_id.clone(),
                    })
                    .now_or_never()
                    .expect("memory operation completes immediately")
            });
            let delete = scope.spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap()
                    .block_on(service.delete_session(DeleteSessionRequest {
                        targets: vec![DeleteSessionTarget {
                            session_id: target.session_id.clone(),
                            expected_metadata_revision: 1,
                            expected_archive_revision: None,
                        }],
                    }))
                    .unwrap();
            });
            let result = subscribe.join().unwrap();
            delete.join().unwrap();
            result
        });
        match result {
            Ok(mut observer) => {
                assert_eq!(snapshot(&mut observer).await, target);
                assert_eq!(
                    receive(&mut observer).await.payload,
                    Some(agent_event::Payload::SessionDeleted(SessionDeleted {
                        session_id: target.session_id,
                    }))
                );
            }
            Err(error) => assert_eq!(error, AgentError::NotFound("session")),
        }
    }
}

#[tokio::test]
async fn missing_invalid_unknown_and_deleted_targets_do_not_open_subscriptions() {
    let service = service();
    for session_id in [String::new(), "invalid".into()] {
        assert!(matches!(
            service
                .subscribe_session(SubscribeSessionRequest { session_id })
                .now_or_never()
                .expect("memory operation completes immediately"),
            Err(AgentError::InvalidArgument("session_id"))
        ));
    }
    let deleted = create(&service);
    service
        .delete_session(DeleteSessionRequest {
            targets: vec![DeleteSessionTarget {
                session_id: deleted.session_id.clone(),
                expected_metadata_revision: 1,
                expected_archive_revision: None,
            }],
        })
        .await
        .unwrap();
    for session_id in [deleted.session_id, SessionId::new().to_string()] {
        assert!(matches!(
            service
                .subscribe_session(SubscribeSessionRequest { session_id })
                .now_or_never()
                .expect("memory operation completes immediately"),
            Err(AgentError::NotFound("session"))
        ));
    }
}

#[test]
fn failed_subscriptions_do_not_use_capacity_and_closing_releases_it() {
    let service = service();
    for _ in 0..65 {
        assert!(matches!(
            service
                .subscribe_session(SubscribeSessionRequest {
                    session_id: SessionId::new().to_string(),
                })
                .now_or_never()
                .expect("memory operation completes immediately"),
            Err(AgentError::NotFound("session"))
        ));
    }
    let session = create(&service);
    let request = SubscribeSessionRequest {
        session_id: session.session_id,
    };
    let observers: Vec<_> = (0..64)
        .map(|_| {
            service
                .subscribe_session(request.clone())
                .now_or_never()
                .expect("memory operation completes immediately")
                .unwrap()
        })
        .collect();
    assert!(matches!(
        service
            .subscribe_session(request.clone())
            .now_or_never()
            .expect("memory operation completes immediately"),
        Err(AgentError::ResourceExhausted(_))
    ));
    observers[0].close();
    assert!(
        service
            .subscribe_session(request)
            .now_or_never()
            .expect("memory operation completes immediately")
            .is_ok()
    );
}
