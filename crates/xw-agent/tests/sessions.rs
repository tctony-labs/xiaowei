use futures_util::FutureExt;
mod support;

use std::sync::Arc;

use support::{config, create, service};
use xw_agent::{AgentError, protocol::*};
use xw_agent_types::ClientRequestId;

#[test]
fn concurrent_create_is_idempotent_and_deleted_creation_never_resurrects() {
    let service = Arc::new(service());
    let request = CreateSessionRequest {
        title_model_ref: String::new(),
        client_request_id: ClientRequestId::new().to_string(),
        config: Some(config()),
    };
    let results = std::thread::scope(|scope| {
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let request = request.clone();
                let service = service.clone();
                scope.spawn(move || {
                    service
                        .create_session(request)
                        .now_or_never()
                        .expect("memory operation completes immediately")
                        .unwrap()
                })
            })
            .collect();
        tasks.into_iter().map(|task| task.join().unwrap()).collect::<Vec<_>>()
    });
    assert!(results.iter().all(|result| *result == results[0]));
    let session = results[0].session.as_ref().unwrap();
    let delete = DeleteSessionRequest {
        targets: vec![DeleteSessionTarget {
            session_id: session.session_id.clone(),
            expected_metadata_revision: session.metadata_revision,
            expected_archive_revision: None,
        }],
    };
    let deleted = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(service.delete_session(delete.clone()))
        .unwrap();
    assert_eq!(
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(service.delete_session(delete))
            .unwrap(),
        deleted
    );
    assert!(
        !service
            .read_session(ReadSessionRequest {
                session_id: session.session_id.clone(),
                include_runs: true,
            })
            .now_or_never()
            .expect("memory operation completes immediately")
            .unwrap()
            .found
    );
    let retried = service
        .create_session(request)
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    assert_eq!(
        retried.session.as_ref().unwrap().status,
        i32::from(AgentSessionStatus::Deleted)
    );
    assert_eq!(retried.session.unwrap().session_id, session.session_id);
}

#[test]
fn creation_and_session_limits_do_not_evict_idempotency() {
    let service = service();
    let request = CreateSessionRequest {
        title_model_ref: String::new(),
        client_request_id: ClientRequestId::new().to_string(),
        config: Some(config()),
    };
    let first = service
        .create_session(request.clone())
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    let mut sessions = vec![first.session.clone().unwrap()];
    for _ in 1..16 {
        sessions.push(create(&service));
    }
    assert_eq!(
        service
            .create_session(request.clone())
            .now_or_never()
            .expect("memory operation completes immediately")
            .unwrap(),
        first
    );
    assert!(matches!(
        service
            .create_session(CreateSessionRequest {
                title_model_ref: String::new(),
                client_request_id: ClientRequestId::new().to_string(),
                config: Some(config()),
            })
            .now_or_never()
            .expect("memory operation completes immediately"),
        Err(AgentError::ResourceExhausted(_))
    ));
    for session in sessions {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(service.delete_session(DeleteSessionRequest {
                targets: vec![DeleteSessionTarget {
                    session_id: session.session_id,
                    expected_metadata_revision: 1,
                    expected_archive_revision: None,
                }],
            }))
            .unwrap();
    }
    for _ in 16..1024 {
        let session = create(&service);
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(service.delete_session(DeleteSessionRequest {
                targets: vec![DeleteSessionTarget {
                    session_id: session.session_id,
                    expected_metadata_revision: 1,
                    expected_archive_revision: None,
                }],
            }))
            .unwrap();
    }
    assert_eq!(
        service
            .create_session(request)
            .now_or_never()
            .expect("memory operation completes immediately")
            .unwrap()
            .session
            .unwrap()
            .status,
        i32::from(AgentSessionStatus::Deleted)
    );
    assert!(matches!(
        service
            .create_session(CreateSessionRequest {
                title_model_ref: String::new(),
                client_request_id: ClientRequestId::new().to_string(),
                config: Some(config()),
            })
            .now_or_never()
            .expect("memory operation completes immediately"),
        Err(AgentError::ResourceExhausted(_))
    ));
}

#[test]
fn malformed_ids_and_metadata_conflicts_do_not_mutate_sessions() {
    let service = service();
    assert!(matches!(
        service
            .create_session(CreateSessionRequest {
                title_model_ref: String::new(),
                client_request_id: "550e8400-e29b-41d4-a716-446655440000".into(),
                config: Some(config()),
            })
            .now_or_never()
            .expect("memory operation completes immediately"),
        Err(AgentError::InvalidArgument(_))
    ));
    let session = create(&service);
    for revision in [0, 2] {
        let result = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(service.delete_session(DeleteSessionRequest {
                targets: vec![DeleteSessionTarget {
                    session_id: session.session_id.clone(),
                    expected_metadata_revision: revision,
                    expected_archive_revision: None,
                }],
            }));
        if revision == 0 {
            assert!(matches!(result, Err(AgentError::InvalidArgument(_))));
        } else {
            assert_eq!(
                result.unwrap().results[0].status,
                i32::from(DeleteSessionStatus::Skipped)
            );
        }
    }
    assert_eq!(
        service
            .read_session(ReadSessionRequest {
                session_id: session.session_id.clone(),
                include_runs: true,
            })
            .now_or_never()
            .expect("memory operation completes immediately")
            .unwrap()
            .session,
        Some(session)
    );
}

#[test]
fn creation_stores_config_and_rejects_conflicting_idempotent_retry() {
    let service = service();
    let request = CreateSessionRequest {
        title_model_ref: String::new(),
        client_request_id: ClientRequestId::new().to_string(),
        config: Some(config()),
    };
    let created = service
        .create_session(request.clone())
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap()
        .session
        .unwrap();
    assert_eq!(created.config, request.config);
    assert_eq!(created.status, i32::from(AgentSessionStatus::Idle));
    assert!(created.runs.is_empty());
    let mut conflicting = request.clone();
    conflicting.config.as_mut().unwrap().reasoning = None;
    assert_eq!(
        service
            .create_session(conflicting)
            .now_or_never()
            .expect("memory operation completes immediately"),
        Err(AgentError::Conflict("creation config"))
    );
    assert_eq!(
        service
            .create_session(request)
            .now_or_never()
            .expect("memory operation completes immediately")
            .unwrap()
            .session,
        Some(created)
    );
}

#[test]
fn missing_and_invalid_config_never_create_a_session() {
    let service = service();
    for config in [
        None,
        Some(AgentModelConfig::default()),
        Some(AgentModelConfig {
            reasoning: Some(String::new()),
            ..config()
        }),
    ] {
        assert!(matches!(
            service
                .create_session(CreateSessionRequest {
                    title_model_ref: String::new(),
                    client_request_id: ClientRequestId::new().to_string(),
                    config,
                })
                .now_or_never()
                .expect("memory operation completes immediately"),
            Err(AgentError::InvalidArgument(_))
        ));
    }
}

#[tokio::test]
async fn list_sessions_orders_live_metadata_and_excludes_deleted_sessions() {
    let service = service();
    assert!(
        service
            .list_sessions(ListSessionsRequest::default())
            .now_or_never()
            .expect("memory operation completes immediately")
            .unwrap()
            .sessions
            .is_empty()
    );
    let first = create(&service);
    let second = create(&service);
    let listed = service
        .list_sessions(ListSessionsRequest::default())
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap()
        .sessions;
    assert_eq!(listed.len(), 2);
    assert!(
        listed.windows(2).all(|pair| {
            (pair[0].created_at_ms, &pair[0].session_id) >= (pair[1].created_at_ms, &pair[1].session_id)
        })
    );
    assert!(listed.iter().any(|session| session.session_id == first.session_id));
    service
        .delete_session(DeleteSessionRequest {
            targets: vec![DeleteSessionTarget {
                session_id: second.session_id,
                expected_metadata_revision: second.metadata_revision,
                expected_archive_revision: None,
            }],
        })
        .await
        .unwrap();
    let retained = service
        .list_sessions(ListSessionsRequest::default())
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap()
        .sessions;
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].session_id, first.session_id);
    assert_eq!(retained[0].status, first.status);
    assert!(retained[0].title.is_empty());
    service.close().await.unwrap();
    assert_eq!(
        service
            .list_sessions(ListSessionsRequest::default())
            .now_or_never()
            .expect("memory operation completes immediately"),
        Err(AgentError::Closed)
    );
}
