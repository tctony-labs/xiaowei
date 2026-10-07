use std::{
    sync::{Arc, Weak},
    time::Duration,
};

use crate::{AgentError, AgentService, CancellationToken, protocol::*, service::now_ms, session::parse_id};

const DAY_MS: i64 = 86_400_000;
const CHECK_INTERVAL: Duration = Duration::from_secs(3600);
const MAX_VIEWERS: usize = 64;

pub(crate) struct MaintenanceTask {
    owner: Weak<AgentService>,
    cancellation: CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

pub(crate) fn validate_policy(policy: &SessionRetentionPolicy) -> Result<(), AgentError> {
    if !matches!(policy.archive_after_days, 1 | 3 | 7 | 15)
        || !matches!(policy.delete_after_days, 0 | 30 | 90 | 180 | 365)
    {
        return Err(AgentError::InvalidArgument("retention days"));
    }
    Ok(())
}

/// A live viewing lease, separate from event observation. Drop releases protection.
pub struct SessionViewing {
    _lease: Arc<()>,
}

impl AgentService {
    pub async fn get_session_retention_policy(&self) -> Result<SessionRetentionPolicy, AgentError> {
        drop(self.state()?);
        let index = self.index.as_ref().ok_or(AgentError::Index)?;
        index.storage.retention_policy().await
    }

    pub async fn set_session_retention_policy(
        &self,
        request: SetSessionRetentionPolicyRequest,
    ) -> Result<SessionRetentionPolicy, AgentError> {
        drop(self.state()?);
        let policy = request.policy.ok_or(AgentError::InvalidArgument("policy"))?;
        validate_policy(&policy)?;
        let index = self.index.as_ref().ok_or(AgentError::Index)?;
        {
            let _gate = index.gate.lock().await;
            drop(self.state()?);
            index.storage.set_retention_policy(&policy).await?;
        }
        log::debug!(
            "Agent retention policy saved archive_days={} delete_days={}",
            policy.archive_after_days,
            policy.delete_after_days
        );
        self.restart_maintenance();
        Ok(policy)
    }

    pub async fn track_session_viewing(
        &self,
        request: TrackSessionViewingRequest,
    ) -> Result<SessionViewing, AgentError> {
        let id = parse_id(&request.session_id, "session_id")?;
        let index = self.index.as_ref().ok_or(AgentError::Index)?;
        let _gate = index.gate.lock().await;
        let record = index.storage.get(&request.session_id).await?;
        let record = record
            .filter(|record| !record.deleting)
            .ok_or(AgentError::NotFound("session"))?;
        if record.summary.archived {
            return Err(AgentError::SessionUnavailable);
        }
        let mut state = self.state()?;
        if state.sessions.get(&id).is_some_and(|session| session.frozen) {
            return Err(AgentError::SessionUnavailable);
        }
        state.viewers.retain(|_, viewers| {
            viewers.retain(|viewer| viewer.strong_count() > 0);
            !viewers.is_empty()
        });
        if state.viewers.values().map(Vec::len).sum::<usize>() >= MAX_VIEWERS {
            return Err(AgentError::ResourceExhausted("session viewers"));
        }
        let lease = Arc::new(());
        state.viewers.entry(id).or_default().push(Arc::downgrade(&lease));
        Ok(SessionViewing { _lease: lease })
    }

    /// Explicit host lifecycle entry. CLI hosts may use the same scheduler.
    /// Opens no histories: each pass reads only registered SQLite candidates.
    pub fn start_maintenance(self: &Arc<Self>) {
        if self.index.is_none() || self.state().is_err() {
            return;
        }
        let mut task = self.maintenance.lock().unwrap();
        if task.is_some() {
            return;
        }
        *task = Some(Self::spawn_maintenance(Arc::downgrade(self), None));
        log::debug!("Agent retention checks started interval_seconds=3600");
    }

    fn restart_maintenance(&self) {
        let mut task = self.maintenance.lock().unwrap();
        if self.state().is_err() {
            return;
        }
        let Some(previous) = task.take() else { return };
        previous.cancellation.cancel();
        *task = Some(Self::spawn_maintenance(previous.owner, Some(previous.handle)));
        log::debug!("Agent retention task restart scheduled interval_seconds=3600");
    }

    fn spawn_maintenance(owner: Weak<Self>, previous: Option<tokio::task::JoinHandle<()>>) -> MaintenanceTask {
        let weak = owner.clone();
        let cancellation = CancellationToken::new();
        let stopped = cancellation.clone();
        let handle = tokio::spawn(async move {
            // A restart must finish the previous check before opening the new timer.
            // Keep this wait inside the task so RPC cancellation cannot strand maintenance.
            if let Some(previous) = previous {
                let _ = previous.await;
            }
            let mut interval = tokio::time::interval(CHECK_INTERVAL);
            loop {
                tokio::select! {
                    biased;
                    _ = stopped.cancelled() => break,
                    _ = interval.tick() => {}
                }
                let Some(service) = weak.upgrade() else { break };
                if let Err(error) = service.maintain_sessions().await {
                    log::warn!("Agent retention check failed error={error}");
                }
            }
        });
        MaintenanceTask {
            owner,
            cancellation,
            handle,
        }
    }

    pub(crate) fn cancel_maintenance(&self) {
        if let Ok(task) = self.maintenance.lock()
            && let Some(task) = task.as_ref()
        {
            task.cancellation.cancel();
        }
    }

    pub(crate) async fn stop_maintenance(&self) {
        let task = self.maintenance.lock().unwrap().take();
        if let Some(task) = task {
            task.cancellation.cancel();
            let _ = task.handle.await;
            log::debug!("Agent retention checks stopped");
        }
    }

    pub async fn maintain_sessions(&self) -> Result<(), AgentError> {
        self.maintain_sessions_at(now_ms()?).await
    }

    pub(crate) async fn maintain_sessions_at(&self, now: i64) -> Result<(), AgentError> {
        let policy = self.get_session_retention_policy().await?;
        let index = self.index.as_ref().ok_or(AgentError::Index)?;
        let cutoff = now.saturating_sub(i64::from(policy.archive_after_days) * DAY_MS);
        let candidates = index.storage.retention_candidates(false, cutoff).await?;
        let mut archived = 0;
        for session in candidates {
            let id = session.session_id;
            match self
                .archive_session_before(
                    SetSessionArchivedRequest {
                        session_id: id.clone(),
                        archived: true,
                        expected_archive_revision: session.archive_revision,
                    },
                    Some(cutoff),
                )
                .await
            {
                Ok(_) => {
                    archived += 1;
                    log::debug!("Agent session auto-archived session={id}");
                }
                Err(AgentError::Conflict(_) | AgentError::NotFound(_)) => {
                    log::debug!("Agent auto-archive skipped session={id} reason=active_viewed_or_changed");
                }
                Err(error) => log::warn!("Agent auto-archive failed session={id} error={error}"),
            }
        }

        let mut deleted = 0;
        if policy.delete_after_days > 0 {
            let cutoff = now.saturating_sub(i64::from(policy.delete_after_days) * DAY_MS);
            for session in index.storage.retention_candidates(true, cutoff).await? {
                let id = session.session_id;
                let revision = self
                    .state()?
                    .sessions
                    .get(&id.parse().map_err(|_| AgentError::Internal)?)
                    .map_or(1, |session| session.view.metadata_revision);
                let response = self
                    .delete_session(DeleteSessionRequest {
                        targets: vec![DeleteSessionTarget {
                            session_id: id.clone(),
                            expected_metadata_revision: revision,
                            expected_archive_revision: Some(session.archive_revision),
                        }],
                    })
                    .await?;
                if response.results[0].status == i32::from(DeleteSessionStatus::Deleted) {
                    deleted += 1;
                    log::debug!("Agent archived session auto-deleted session={id}");
                }
            }
        }
        log::debug!("Agent retention check settled archived={archived} deleted={deleted}");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentHost, GenerationFuture, GenerationRequest, InputSource, SourceKind};
    use xw_agent_types::{ClientRequestId, InputId};

    fn age_journal(root: &std::path::Path, session: &AgentSession) {
        let store = xw_agent_rollout::RolloutStore::new(root);
        let id = parse_id(&session.session_id, "session_id").unwrap();
        let (journal, _) = store.open_registered(id, session.created_at_ms).unwrap();
        assert_eq!(journal.entries().len(), 2, "aging fixture must be a blank session");
        let xw_agent_types::EntryPayload::Meta(meta) = journal.entries()[1].payload.clone() else {
            panic!("missing meta");
        };
        let path = journal.path().to_owned();
        drop(journal);
        std::fs::remove_file(path).unwrap();
        drop(store.create(id, 1, meta).unwrap());
    }

    struct Host;

    impl AgentHost for Host {
        fn generate(&self, _: GenerationRequest, cancellation: CancellationToken) -> GenerationFuture {
            Box::pin(async move {
                cancellation.cancelled().await;
                Err(crate::GenerationError::Cancelled)
            })
        }

        fn get_model_info(&self, _: String) -> crate::ModelInfoFuture {
            Box::pin(async { Err(crate::ModelInfoError::Unavailable) })
        }

        fn get_auxiliary_model_ref(&self) -> crate::AuxiliaryModelRefFuture {
            Box::pin(async { Ok(None) })
        }
    }

    async fn create(service: &AgentService) -> AgentSession {
        service
            .create_session_with_source(
                CreateSessionRequest {
                    client_request_id: ClientRequestId::new().to_string(),
                    config: Some(AgentModelConfig {
                        model_ref: "model".into(),
                        reasoning: None,
                    }),
                    ..Default::default()
                },
                InputSource {
                    kind: SourceKind::Internal,
                    principal_id: "test".into(),
                },
            )
            .await
            .unwrap()
            .session
            .unwrap()
    }

    async fn list(service: &AgentService, archived: bool) -> Vec<AgentSessionSummary> {
        service
            .list_sessions(ListSessionsRequest {
                archived,
                ..Default::default()
            })
            .await
            .unwrap()
            .sessions
    }

    #[tokio::test]
    async fn exact_threshold_respects_each_viewer_and_observation_alone_does_not_protect() {
        let root = tempfile::tempdir().unwrap();
        let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
        let session = create(&service).await;
        let observation = service
            .subscribe_session(SubscribeSessionRequest {
                session_id: session.session_id.clone(),
            })
            .await
            .unwrap();
        let request = TrackSessionViewingRequest {
            session_id: session.session_id.clone(),
        };
        let first = service.track_session_viewing(request.clone()).await.unwrap();
        let second = service.track_session_viewing(request).await.unwrap();
        let cutoff = session.updated_at_ms + 3 * DAY_MS;
        service.maintain_sessions_at(cutoff - 1).await.unwrap();
        assert_eq!(list(&service, false).await.len(), 1);
        service.maintain_sessions_at(cutoff).await.unwrap();
        assert_eq!(list(&service, false).await.len(), 1);
        drop(first);
        service.maintain_sessions_at(cutoff).await.unwrap();
        assert_eq!(list(&service, false).await.len(), 1);
        drop(second);
        service.maintain_sessions_at(cutoff).await.unwrap();
        assert_eq!(list(&service, true).await.len(), 1);
        assert!(
            service
                .track_session_viewing(TrackSessionViewingRequest {
                    session_id: session.session_id,
                })
                .await
                .is_err()
        );
        drop(observation);
        service.close().await.unwrap();
    }

    #[tokio::test]
    async fn delete_off_retains_history_and_enabled_cleanup_uses_last_activity() {
        let root = tempfile::tempdir().unwrap();
        let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
        let session = create(&service).await;
        let path = {
            let state = service.state().unwrap();
            let id = parse_id(&session.session_id, "session_id").unwrap();
            state.sessions[&id].journal.as_ref().unwrap().path().to_owned()
        };
        let now = session.updated_at_ms + 30 * DAY_MS;
        service.maintain_sessions_at(now).await.unwrap();
        assert_eq!(list(&service, true).await.len(), 1);
        service
            .set_session_retention_policy(SetSessionRetentionPolicyRequest {
                policy: Some(SessionRetentionPolicy {
                    archive_after_days: 3,
                    delete_after_days: 30,
                }),
            })
            .await
            .unwrap();
        service.maintain_sessions_at(now - 1).await.unwrap();
        assert_eq!(list(&service, true).await.len(), 1);
        service.maintain_sessions_at(now).await.unwrap();
        assert!(list(&service, true).await.is_empty());
        assert!(!path.exists(), "automatic deletion removes the registered JSONL");
        service.close().await.unwrap();
    }

    #[tokio::test]
    async fn restore_refreshes_activity_and_invalid_policy_does_not_change_defaults() {
        let root = tempfile::tempdir().unwrap();
        let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
        let session = create(&service).await;
        service.close().await.unwrap();
        age_journal(root.path(), &session);
        let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", root.path().join("sessions.sqlite").display()))
            .await
            .unwrap();
        sqlx::query("UPDATE session SET created_at_ms = 1, updated_at_ms = 1")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
        service.maintain_sessions().await.unwrap();
        service
            .set_session_archived(SetSessionArchivedRequest {
                session_id: session.session_id,
                archived: false,
                expected_archive_revision: 2,
            })
            .await
            .unwrap();
        let restored = list(&service, false).await.remove(0);
        assert!(restored.updated_at_ms >= session.updated_at_ms);
        service.maintain_sessions().await.unwrap();
        assert_eq!(list(&service, false).await.len(), 1);
        for policy in [
            None,
            Some(SessionRetentionPolicy {
                archive_after_days: 0,
                delete_after_days: 30,
            }),
            Some(SessionRetentionPolicy {
                archive_after_days: 3,
                delete_after_days: 1,
            }),
        ] {
            assert!(
                service
                    .set_session_retention_policy(SetSessionRetentionPolicyRequest { policy })
                    .await
                    .is_err()
            );
        }
        assert_eq!(
            service.get_session_retention_policy().await.unwrap().archive_after_days,
            3
        );
        service.close().await.unwrap();
    }

    #[tokio::test]
    async fn active_run_is_never_cancelled_by_automatic_archive() {
        let root = tempfile::tempdir().unwrap();
        let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
        let session = create(&service).await;
        let run = service
            .start_run(
                StartRunRequest {
                    session_id: session.session_id.clone(),
                    input_id: InputId::new().to_string(),
                    input: vec![AgentUserInput {
                        content: Some(agent_user_input::Content::Text("hello".into())),
                    }],
                    ..Default::default()
                },
                InputSource {
                    kind: SourceKind::Internal,
                    principal_id: "test".into(),
                },
            )
            .await
            .unwrap();
        service
            .maintain_sessions_at(now_ms().unwrap() + 40 * DAY_MS)
            .await
            .unwrap();
        assert_eq!(list(&service, false).await.len(), 1);
        let read = service
            .read_session(ReadSessionRequest {
                session_id: session.session_id.clone(),
                include_runs: true,
            })
            .await
            .unwrap()
            .session
            .unwrap();
        assert_eq!(read.runs[0].status, i32::from(AgentRunStatus::InProgress));
        service
            .interrupt_run(InterruptRunRequest {
                session_id: session.session_id,
                run_id: run.run.unwrap().run_id,
            })
            .unwrap();
        service.close().await.unwrap();
    }

    #[tokio::test]
    async fn scheduler_checks_at_start_and_stops_before_database_close() {
        let root = tempfile::tempdir().unwrap();
        let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
        let session = create(&service).await;
        service.close().await.unwrap();
        age_journal(root.path(), &session);
        let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", root.path().join("sessions.sqlite").display()))
            .await
            .unwrap();
        sqlx::query("UPDATE session SET created_at_ms = 1, updated_at_ms = 1")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let service = Arc::new(AgentService::open(Arc::new(Host), root.path().into()).await.unwrap());
        service.start_maintenance();
        service.start_maintenance();
        tokio::time::timeout(Duration::from_secs(2), async {
            while list(&service, true).await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        service.close().await.unwrap();
        assert!(service.maintenance.lock().unwrap().is_none());
        service.close().await.unwrap();
        service.start_maintenance();
        assert!(service.maintenance.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn cold_viewing_racing_auto_archive_never_acknowledges_both() {
        let root = tempfile::tempdir().unwrap();
        let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
        let mut sessions = Vec::new();
        for _ in 0..30 {
            sessions.push(create(&service).await);
        }
        service.close().await.unwrap();
        let service = Arc::new(AgentService::open(Arc::new(Host), root.path().into()).await.unwrap());
        for session in sessions {
            let archive_service = service.clone();
            let archive_id = session.session_id.clone();
            let archive = tokio::spawn(async move {
                archive_service
                    .archive_session_before(
                        SetSessionArchivedRequest {
                            session_id: archive_id,
                            archived: true,
                            expected_archive_revision: 1,
                        },
                        Some(i64::MAX),
                    )
                    .await
            });
            let viewer = service
                .track_session_viewing(TrackSessionViewingRequest {
                    session_id: session.session_id,
                })
                .await;
            let archived = archive.await.unwrap();
            assert!(
                !(viewer.is_ok() && archived.is_ok()),
                "an acknowledged viewer must prevent automatic archive"
            );
        }
        service.close().await.unwrap();
    }

    #[tokio::test]
    async fn saving_policy_replaces_the_task_and_checks_without_waiting_an_hour() {
        let root = tempfile::tempdir().unwrap();
        let service = AgentService::open(Arc::new(Host), root.path().into()).await.unwrap();
        let session = create(&service).await;
        service.close().await.unwrap();
        age_journal(root.path(), &session);
        let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", root.path().join("sessions.sqlite").display()))
            .await
            .unwrap();
        sqlx::query("UPDATE session SET created_at_ms = 1, updated_at_ms = 1")
            .execute(&pool)
            .await
            .unwrap();
        let service = Arc::new(AgentService::open(Arc::new(Host), root.path().into()).await.unwrap());
        service.start_maintenance();
        tokio::time::timeout(Duration::from_secs(2), async {
            while list(&service, true).await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let original = service.maintenance.lock().unwrap().as_ref().unwrap().handle.id();
        sqlx::query(
            "CREATE TRIGGER fail_policy BEFORE UPDATE ON meta
             WHEN NEW.key = 'retention.delete_after_days' BEGIN SELECT RAISE(ABORT, 'failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        let request = SetSessionRetentionPolicyRequest {
            policy: Some(SessionRetentionPolicy {
                archive_after_days: 7,
                delete_after_days: 30,
            }),
        };
        assert!(service.set_session_retention_policy(request).await.is_err());
        assert_eq!(
            service.maintenance.lock().unwrap().as_ref().unwrap().handle.id(),
            original
        );
        assert_eq!(
            service.get_session_retention_policy().await.unwrap(),
            SessionRetentionPolicy {
                archive_after_days: 3,
                delete_after_days: 0,
            }
        );
        sqlx::query("DROP TRIGGER fail_policy").execute(&pool).await.unwrap();
        service.set_session_retention_policy(request).await.unwrap();
        assert_ne!(
            service.maintenance.lock().unwrap().as_ref().unwrap().handle.id(),
            original
        );
        tokio::time::timeout(Duration::from_secs(2), async {
            while service
                .index
                .as_ref()
                .unwrap()
                .storage
                .get(&session.session_id)
                .await
                .unwrap()
                .is_some()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        service.close().await.unwrap();
        pool.close().await;
    }

    #[tokio::test]
    async fn closing_after_repeated_restarts_waits_for_the_task_chain() {
        let root = tempfile::tempdir().unwrap();
        let service = Arc::new(AgentService::open(Arc::new(Host), root.path().into()).await.unwrap());
        create(&service).await;
        service.start_maintenance();
        for days in [1, 3, 7, 15, 3] {
            service
                .set_session_retention_policy(SetSessionRetentionPolicyRequest {
                    policy: Some(SessionRetentionPolicy {
                        archive_after_days: days,
                        delete_after_days: 0,
                    }),
                })
                .await
                .unwrap();
        }
        service.close().await.unwrap();
        assert!(service.maintenance.lock().unwrap().is_none());
        assert!(service.get_session_retention_policy().await.is_err());
    }
}
