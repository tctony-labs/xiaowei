use std::{path::Path, sync::Arc};

use xw_agent::{
    AgentError, AgentHost, AgentService, CancellationToken, GenerationFuture, GenerationRequest, protocol::*,
};
use xw_agent_types::{ClientRequestId, InputId, InputSource, SourceKind};

struct Host;

impl AgentHost for Host {
    fn get_model_info(&self, _: String) -> xw_agent::ModelInfoFuture {
        Box::pin(async { Err(xw_agent::ModelInfoError::Unavailable) })
    }
    fn get_auxiliary_model_ref(&self) -> xw_agent::AuxiliaryModelRefFuture {
        Box::pin(async { Ok(None) })
    }
    fn generate(&self, _: GenerationRequest, cancellation: CancellationToken) -> GenerationFuture {
        Box::pin(async move {
            cancellation.cancelled().await;
            Err(xw_agent::GenerationError::Cancelled)
        })
    }
}

fn source() -> InputSource {
    InputSource {
        kind: SourceKind::Internal,
        principal_id: "cli".into(),
    }
}

fn create_request() -> CreateSessionRequest {
    CreateSessionRequest {
        client_request_id: ClientRequestId::new().to_string(),
        config: Some(AgentModelConfig {
            model_ref: "model".into(),
            reasoning: None,
        }),
        ..Default::default()
    }
}

fn journal(root: &Path, id: &str) -> std::path::PathBuf {
    fn find(root: &Path, id: &str) -> Option<std::path::PathBuf> {
        for entry in std::fs::read_dir(root).ok()?.flatten() {
            if entry.file_name() == format!("{id}.jsonl").as_str() {
                return Some(entry.path());
            }
            if entry.file_type().ok()?.is_dir()
                && let Some(found) = find(&entry.path(), id)
            {
                return Some(found);
            }
        }
        None
    }
    find(&root.join("sessions"), id).unwrap()
}

#[tokio::test]
async fn sqlite_directory_and_title_survive_without_startup_history_reads() {
    let root = tempfile::tempdir().unwrap();
    let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
    let creation = create_request();
    let view = service
        .create_session_with_source(creation.clone(), source())
        .await
        .unwrap()
        .session
        .unwrap();
    let path = journal(root.path(), &view.session_id);
    let original = std::fs::read(&path).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    service
        .set_session_title(SetSessionTitleRequest {
            session_id: view.session_id.clone(),
            title: "SQLite标题".into(),
        })
        .await
        .unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), original, "renaming must not append Meta");
    let renamed = service
        .read_session(ReadSessionRequest {
            session_id: view.session_id.clone(),
            include_runs: false,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    assert!(renamed.updated_at_ms > view.updated_at_ms);
    let connection = sqlx::SqlitePool::connect(&format!("sqlite://{}", root.path().join("sessions.sqlite").display()))
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER fail_update BEFORE UPDATE ON session BEGIN SELECT RAISE(ABORT, 'failure'); END")
        .execute(&connection)
        .await
        .unwrap();
    assert!(matches!(
        service
            .set_session_config(SetSessionConfigRequest {
                session_id: view.session_id.clone(),
                config: Some(AgentModelConfig {
                    model_ref: "new-model".into(),
                    reasoning: Some("high".into()),
                }),
                expected_metadata_revision: 2,
            })
            .await,
        Err(AgentError::Index)
    ));
    let read = ReadSessionRequest {
        session_id: view.session_id.clone(),
        include_runs: true,
    };
    assert!(matches!(
        service.read_session(read.clone()).await,
        Err(AgentError::Index)
    ));
    sqlx::query("DROP TRIGGER fail_update")
        .execute(&connection)
        .await
        .unwrap();
    let recovered = service.read_session(read).await.unwrap().session.unwrap();
    assert_eq!(recovered.config.unwrap().model_ref, "new-model");
    assert_eq!(recovered.metadata_revision, 3);
    let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('session')")
        .fetch_all(&connection)
        .await
        .unwrap();
    assert!(!columns.iter().any(|name| name == "metadata_revision"));
    let history = std::fs::read_to_string(&path).unwrap();
    assert!(
        !history.contains("SQLite标题"),
        "later Meta commits must not copy SQLite titles"
    );
    connection.close().await;
    service.close().await.unwrap();
    let corrupt = root.path().join("sessions/2026/10/orphan.jsonl");
    std::fs::create_dir_all(corrupt.parent().unwrap()).unwrap();
    std::fs::write(&corrupt, "invalid orphan history").unwrap();
    let reopened = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
    let list = reopened.list_sessions(ListSessionsRequest::default()).await.unwrap();
    assert_eq!(list.sessions.len(), 1);
    assert_eq!(list.sessions[0].title, "SQLite标题");
    assert!(!list.sessions[0].auto_title_enabled);
    let same = reopened
        .read_session(ReadSessionRequest {
            session_id: view.session_id.clone(),
            include_runs: true,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    assert_eq!(same.session_id, view.session_id);
    assert_eq!(same.title, "SQLite标题");
    assert!(!same.auto_title_enabled);
    assert_eq!(same.metadata_revision, 1);
    assert_eq!(list.sessions[0].metadata_revision, 1);
    reopened.close().await.unwrap();
    // Even a registered damaged history does not prevent startup or directory listing.
    std::fs::write(&path, "complete invalid line\n").unwrap();
    let isolated = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
    assert_eq!(
        isolated
            .list_sessions(ListSessionsRequest::default())
            .await
            .unwrap()
            .sessions[0]
            .title,
        "SQLite标题"
    );
    assert!(
        isolated
            .read_session(ReadSessionRequest {
                session_id: view.session_id,
                include_runs: true
            })
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(path).unwrap(), b"complete invalid line\n");
    isolated.close().await.unwrap();
}

#[tokio::test]
async fn creation_retries_use_original_arguments_only_within_the_current_service_instance() {
    let root = tempfile::tempdir().unwrap();
    let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
    let request = create_request();
    let first = service.create_session(request.clone()).await.unwrap().session.unwrap();
    service
        .set_session_config(SetSessionConfigRequest {
            session_id: first.session_id.clone(),
            config: Some(AgentModelConfig {
                model_ref: "changed-model".into(),
                reasoning: Some("high".into()),
            }),
            expected_metadata_revision: first.metadata_revision,
        })
        .await
        .unwrap();
    let repeated = service.create_session(request.clone()).await.unwrap().session.unwrap();
    assert_eq!(repeated.session_id, first.session_id);
    assert_eq!(repeated.config.as_ref().unwrap().model_ref, "changed-model");
    let mut conflicting = request.clone();
    conflicting.config = repeated.config;
    assert!(matches!(
        service.create_session(conflicting).await,
        Err(AgentError::Conflict(_))
    ));
    service.close().await.unwrap();

    let reopened = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
    let restored = reopened
        .read_session(ReadSessionRequest {
            session_id: first.session_id.clone(),
            include_runs: true,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    assert_eq!(restored.config.as_ref().unwrap().model_ref, "changed-model");
    let new = reopened.create_session(request.clone()).await.unwrap().session.unwrap();
    assert_ne!(
        new.session_id, first.session_id,
        "creation keys are not restored from SQL or JSONL"
    );
    let duplicate = reopened.create_session(request).await.unwrap().session.unwrap();
    assert_eq!(duplicate.session_id, new.session_id);
    assert_eq!(
        reopened
            .list_sessions(ListSessionsRequest::default())
            .await
            .unwrap()
            .sessions
            .len(),
        2
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn initial_title_archive_terminal_stream_and_unarchive_are_core_business() {
    let root = tempfile::tempdir().unwrap();
    let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
    let view = service
        .create_session_with_source(create_request(), source())
        .await
        .unwrap()
        .session
        .unwrap();
    let mut stream = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: view.session_id.clone(),
        })
        .await
        .unwrap();
    stream.recv().await.unwrap().unwrap();
    service
        .start_run(
            StartRunRequest {
                session_id: view.session_id.clone(),
                input_id: InputId::new().to_string(),
                input: vec![AgentUserInput {
                    content: Some(agent_user_input::Content::Text(
                        "一二三四五六七八九十一二三四五六七八九十".into(),
                    )),
                }],
                ..Default::default()
            },
            source(),
        )
        .await
        .unwrap();
    let archived = service
        .set_session_archived(SetSessionArchivedRequest {
            session_id: view.session_id.clone(),
            archived: true,
            expected_archive_revision: 1,
        })
        .await
        .unwrap();
    assert_eq!(archived.archive_revision, 2);
    let mut events = Vec::new();
    while let Some(event) = stream.recv().await {
        events.push(event.unwrap());
    }
    let terminal = events
        .iter()
        .position(|e| matches!(e.payload, Some(agent_event::Payload::RunCompleted(_))))
        .unwrap();
    let archive = events
        .iter()
        .position(|e| matches!(e.payload, Some(agent_event::Payload::SessionArchivedUpdated(_))))
        .unwrap();
    assert!(terminal < archive);
    assert!(
        service
            .list_sessions(ListSessionsRequest::default())
            .await
            .unwrap()
            .sessions
            .is_empty()
    );
    let list = service
        .list_sessions(ListSessionsRequest {
            archived: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(list.sessions[0].title, "一二三四五六七八九十一二三四五");
    assert!(matches!(
        service
            .read_session(ReadSessionRequest {
                session_id: view.session_id.clone(),
                include_runs: true
            })
            .await,
        Err(AgentError::SessionUnavailable)
    ));
    assert!(matches!(
        service
            .set_session_title(SetSessionTitleRequest {
                session_id: view.session_id.clone(),
                title: "blocked".into()
            })
            .await,
        Err(AgentError::SessionUnavailable)
    ));
    assert!(matches!(
        service
            .set_session_archived(SetSessionArchivedRequest {
                session_id: view.session_id.clone(),
                archived: false,
                expected_archive_revision: 1,
            })
            .await,
        Err(AgentError::Conflict(_))
    ));
    service
        .set_session_archived(SetSessionArchivedRequest {
            session_id: view.session_id.clone(),
            archived: false,
            expected_archive_revision: 2,
        })
        .await
        .unwrap();
    let recovered = service
        .read_session(ReadSessionRequest {
            session_id: view.session_id.clone(),
            include_runs: true,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    assert_eq!(recovered.runs[0].status, i32::from(AgentRunStatus::Interrupted));
    assert!(recovered.auto_title_enabled);
    assert_eq!(recovered.archive_revision, 3);
    service
        .set_session_archived(SetSessionArchivedRequest {
            session_id: view.session_id.clone(),
            archived: true,
            expected_archive_revision: 3,
        })
        .await
        .unwrap();
    let path = journal(root.path(), &view.session_id);
    service
        .delete_session(DeleteSessionRequest {
            targets: vec![DeleteSessionTarget {
                session_id: view.session_id.clone(),
                expected_metadata_revision: recovered.metadata_revision,
                expected_archive_revision: None,
            }],
        })
        .await
        .unwrap();
    assert!(!path.exists());
    assert!(!root.path().join("deletions").exists());
    service.close().await.unwrap();
    let reopened = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
    assert!(
        reopened
            .list_sessions(ListSessionsRequest {
                archived: true,
                ..Default::default()
            })
            .await
            .unwrap()
            .sessions
            .is_empty()
    );
    reopened.close().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn failed_delete_keeps_pending_sql_state_and_only_known_paths_are_retried() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("keep"), "outside").unwrap();
    let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
    let view = service
        .create_session_with_source(create_request(), source())
        .await
        .unwrap()
        .session
        .unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("workspaces")).unwrap();
    assert_eq!(
        service
            .delete_session(DeleteSessionRequest {
                targets: vec![DeleteSessionTarget {
                    session_id: view.session_id.clone(),
                    expected_metadata_revision: view.metadata_revision,
                    expected_archive_revision: None,
                }],
            })
            .await
            .unwrap()
            .results[0]
            .status,
        i32::from(DeleteSessionStatus::Failed)
    );
    assert!(
        service
            .list_sessions(ListSessionsRequest::default())
            .await
            .unwrap()
            .sessions
            .is_empty()
    );
    assert_eq!(std::fs::read(outside.path().join("keep")).unwrap(), b"outside");
    service.close().await.unwrap();
    std::fs::remove_file(root.path().join("workspaces")).unwrap();
    let reopened = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
    let connection = sqlx::SqlitePool::connect(&format!("sqlite://{}", root.path().join("sessions.sqlite").display()))
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM session WHERE deleting = 1")
        .fetch_one(&connection)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(std::fs::read(outside.path().join("keep")).unwrap(), b"outside");
    connection.close().await;
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn another_hosts_writer_blocks_archive_and_delete_before_sql_changes() {
    let root = tempfile::tempdir().unwrap();
    let owner = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
    let view = owner
        .create_session_with_source(create_request(), source())
        .await
        .unwrap()
        .session
        .unwrap();
    let other = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
    assert!(matches!(
        other
            .set_session_archived(SetSessionArchivedRequest {
                session_id: view.session_id.clone(),
                archived: true,
                expected_archive_revision: 1,
            })
            .await,
        Err(AgentError::Conflict(_))
    ));
    assert_eq!(
        other
            .delete_session(DeleteSessionRequest {
                targets: vec![DeleteSessionTarget {
                    session_id: view.session_id.clone(),
                    expected_metadata_revision: view.metadata_revision,
                    expected_archive_revision: None,
                }],
            })
            .await
            .unwrap()
            .results[0]
            .status,
        i32::from(DeleteSessionStatus::Failed)
    );
    assert_eq!(
        owner
            .list_sessions(ListSessionsRequest::default())
            .await
            .unwrap()
            .sessions
            .len(),
        1
    );
    other.close().await.unwrap();
    owner.close().await.unwrap();
}

fn deletion_target(view: &AgentSession, archived: bool) -> DeleteSessionTarget {
    DeleteSessionTarget {
        session_id: view.session_id.clone(),
        expected_metadata_revision: view.metadata_revision,
        expected_archive_revision: archived.then_some(2),
    }
}

#[tokio::test]
async fn batch_delete_uses_explicit_targets_skips_restored_and_rejects_invalid_batch_before_mutation() {
    let root = tempfile::tempdir().unwrap();
    let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
    let mut views = Vec::new();
    for _ in 0..4 {
        let view = service.create_session(create_request()).await.unwrap().session.unwrap();
        service
            .set_session_archived(SetSessionArchivedRequest {
                session_id: view.session_id.clone(),
                archived: true,
                expected_archive_revision: 1,
            })
            .await
            .unwrap();
        views.push(view);
    }
    let target = deletion_target(&views[0], true);
    for targets in [
        vec![target.clone(), target.clone()],
        vec![
            target.clone(),
            DeleteSessionTarget {
                session_id: "invalid".into(),
                expected_metadata_revision: 1,
                expected_archive_revision: None,
            },
        ],
    ] {
        assert!(matches!(
            service.delete_session(DeleteSessionRequest { targets }).await,
            Err(AgentError::InvalidArgument(_))
        ));
        assert!(journal(root.path(), &views[0].session_id).exists());
    }
    service
        .set_session_archived(SetSessionArchivedRequest {
            session_id: views[1].session_id.clone(),
            archived: false,
            expected_archive_revision: 2,
        })
        .await
        .unwrap();
    let mut stale = deletion_target(&views[2], true);
    stale.expected_metadata_revision += 1;
    let result = service
        .delete_session(DeleteSessionRequest {
            targets: vec![target, deletion_target(&views[1], true), stale],
        })
        .await
        .unwrap();
    assert_eq!(
        result.results.iter().map(|r| r.status).collect::<Vec<_>>(),
        vec![
            i32::from(DeleteSessionStatus::Deleted),
            i32::from(DeleteSessionStatus::Skipped),
            i32::from(DeleteSessionStatus::Skipped),
        ]
    );
    let remaining = service
        .list_sessions(ListSessionsRequest {
            archived: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(remaining.sessions.len(), 2);
    assert!(
        remaining.sessions.iter().any(|r| r.session_id == views[3].session_id),
        "unsubmitted target survives"
    );
    assert!(
        service
            .read_session(ReadSessionRequest {
                session_id: views[1].session_id.clone(),
                ..Default::default()
            })
            .await
            .unwrap()
            .found
    );
    service.close().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn batch_stops_on_cleanup_failure_preserves_completed_deletions_and_does_not_execute_remaining_targets() {
    let root = tempfile::tempdir().unwrap();
    let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
    let mut views = Vec::new();
    for _ in 0..3 {
        views.push(service.create_session(create_request()).await.unwrap().session.unwrap());
    }
    let first_path = journal(root.path(), &views[0].session_id);
    let last_path = journal(root.path(), &views[2].session_id);
    // Replace only the second registered file with a directory: remove_file must fail.
    let failed_path = journal(root.path(), &views[1].session_id);
    std::fs::remove_file(&failed_path).unwrap();
    std::fs::create_dir(&failed_path).unwrap();
    let result = service
        .delete_session(DeleteSessionRequest {
            targets: views.iter().map(|view| deletion_target(view, false)).collect(),
        })
        .await
        .unwrap();
    assert_eq!(
        result.results.iter().map(|r| r.status).collect::<Vec<_>>(),
        vec![
            i32::from(DeleteSessionStatus::Deleted),
            i32::from(DeleteSessionStatus::Failed),
            i32::from(DeleteSessionStatus::NotExecuted),
        ]
    );
    assert!(!first_path.exists());
    assert!(last_path.exists());
    assert!(!result.results[1].error.is_empty());
    std::fs::remove_dir(&failed_path).unwrap();
    let retry = service
        .delete_session(DeleteSessionRequest {
            targets: vec![deletion_target(&views[1], false), deletion_target(&views[2], false)],
        })
        .await
        .unwrap();
    assert!(
        retry
            .results
            .iter()
            .all(|result| result.status == i32::from(DeleteSessionStatus::Deleted))
    );
    service.close().await.unwrap();
}
