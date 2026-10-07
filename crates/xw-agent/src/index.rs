use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use xw_agent_types::{ClientRequestId, SessionId};

use crate::{
    AgentError, AgentHost, AgentService, EventSubscription, InputSource,
    protocol::*,
    service::{State, now_ms},
    session::{Session, parse_id},
};

use crate::catalog::AgentIndexRecord;

pub(crate) struct IndexAccess {
    pub(crate) storage: Arc<crate::catalog::SessionCatalog>,
    // Serializes index-backed control mutations and background commits. State locks
    // remain short and are never held across database awaits.
    pub(crate) gate: tokio::sync::Mutex<()>,
}

pub(crate) fn summary(session: &Session) -> AgentSessionSummary {
    AgentSessionSummary {
        session_id: session.view.session_id.clone(),
        title: session.view.title.clone(),
        auto_title_enabled: session.view.auto_title_enabled,
        status: session.view.status,
        metadata_revision: session.view.metadata_revision,
        created_at_ms: session.view.created_at_ms,
        updated_at_ms: session.view.updated_at_ms,
        archived: session.view.archived,
        archive_revision: session.view.archive_revision,
    }
}

impl AgentService {
    /// Opens the session directory without enumerating JSONL histories.
    /// Both desktop and CLI hosts supply the root and model callbacks only.
    pub async fn open(host: Arc<dyn AgentHost>, root: PathBuf) -> Result<Self, AgentError> {
        let catalog = Arc::new(crate::catalog::SessionCatalog::open(&root.join("sessions.sqlite")).await?);
        let mut service = Self::new(host);
        service.rollout = Some(xw_agent_rollout::RolloutStore::new(root));
        service.index = Some(Arc::new(IndexAccess {
            storage: catalog,
            gate: tokio::sync::Mutex::new(()),
        }));
        service.finish_pending_deletions().await?;
        Ok(service)
    }

    async fn load(&self, id: SessionId) -> Result<bool, AgentError> {
        let Some(index) = &self.index else {
            return Ok(self.state()?.sessions.contains_key(&id));
        };
        let record = index.storage.get(&id.to_string()).await?;
        let Some(record) = record.filter(|r| !r.deleting) else {
            return Ok(false);
        };
        let stored = &record.summary;
        if stored.archived {
            return Err(AgentError::SessionUnavailable);
        }
        let cached = {
            let state = self.state()?;
            if let Some(session) = state.sessions.get(&id) {
                session.available()?;
                Some((!session.deleted(), session.index_dirty))
            } else {
                None
            }
        };
        if let Some((available, dirty)) = cached {
            if dirty {
                self.flush_locked(id).await?;
            }
            return Ok(available);
        }
        let store = self.rollout.as_ref().ok_or(AgentError::Internal)?;
        let (mut journal, repair) = store
            .open_registered(id, stored.created_at_ms)
            .map_err(crate::persistence::storage_error)?;
        crate::settle_interrupted(&mut journal, None, now_ms()?).map_err(crate::persistence::storage_error)?;
        let mut session = crate::persistence::restore(journal)?;
        session.indexed = true;
        session.view.title = stored.title.clone();
        session.view.auto_title_enabled = stored.auto_title_enabled;
        session.view.updated_at_ms = session
            .journal
            .as_ref()
            .unwrap()
            .entries()
            .last()
            .map_or(stored.updated_at_ms, |entry| entry.timestamp_ms)
            .max(stored.updated_at_ms);
        session.view.archive_revision = stored.archive_revision;
        self.state()?.sessions.insert(id, session);
        self.flush_locked(id).await?;
        log::debug!(
            "Agent session loaded session={id} repaired_bytes={}",
            repair.discarded_bytes
        );
        Ok(true)
    }

    async fn require(&self, id: &str) -> Result<SessionId, AgentError> {
        let id = parse_id(id, "session_id")?;
        if !self.load(id).await? {
            return Err(AgentError::NotFound("session"));
        }
        Ok(id)
    }

    pub async fn create_session(&self, request: CreateSessionRequest) -> Result<CreateSessionResponse, AgentError> {
        self.create_session_with_source(
            request,
            crate::InputSource {
                kind: crate::SourceKind::Internal,
                principal_id: "host".into(),
            },
        )
        .await
    }

    pub async fn create_session_with_source(
        &self,
        request: CreateSessionRequest,
        source: InputSource,
    ) -> Result<CreateSessionResponse, AgentError> {
        drop(self.state()?);
        let Some(index) = &self.index else {
            return self.create_loaded_with_source(request, source).await;
        };
        let _gate = index.gate.lock().await;
        if source.principal_id.trim().is_empty() {
            return Err(AgentError::InvalidArgument("source.principal_id"));
        }
        let request_id: ClientRequestId = parse_id(&request.client_request_id, "client_request_id")?;
        let config = request.config.as_ref().ok_or(AgentError::InvalidArgument("config"))?;
        crate::input::validate_config(config)?;
        let previous = self.state()?.creations.get(&request_id).cloned();
        if let Some((id, original_config)) = previous {
            if &original_config != config {
                return Err(AgentError::Conflict("creation config"));
            }
            self.require(&id.to_string()).await?;
            return Ok(CreateSessionResponse {
                session: self
                    .read_loaded(ReadSessionRequest {
                        session_id: id.to_string(),
                        include_runs: true,
                    })?
                    .session,
            });
        }
        let response = self.create_loaded_with_source(request, source).await?;
        let view = response.session.as_ref().ok_or(AgentError::Internal)?;
        let id: SessionId = parse_id(&view.session_id, "session_id")?;
        let record = {
            let state = self.state()?;
            let session = &state.sessions[&id];
            AgentIndexRecord {
                summary: summary(session),
                deleting: false,
            }
        };
        if let Err(error) = index.storage.register(record).await {
            let mut state = self.state()?;
            if let Some(session) = state.sessions.remove(&id)
                && let Some(journal) = session.journal
            {
                let created_at_ms = session.view.created_at_ms;
                drop(journal);
                if let Err(cleanup) = self.rollout.as_ref().unwrap().delete_registered(id, created_at_ms) {
                    log::error!("Agent failed creation cleanup session={id} error={cleanup}");
                }
            }
            state.creations.retain(|_, (session_id, _)| *session_id != id);
            return Err(error);
        }
        Ok(response)
    }

    pub async fn list_sessions(&self, request: ListSessionsRequest) -> Result<ListSessionsResponse, AgentError> {
        drop(self.state()?);
        let Some(index) = &self.index else {
            return self.list_loaded(request);
        };
        let _gate = index.gate.lock().await;
        let mut response = index.storage.list(request).await?;
        let state = self.state()?;
        for stored in &mut response.sessions {
            if let Ok(id) = stored.session_id.parse::<SessionId>()
                && let Some(session) = state.sessions.get(&id)
            {
                stored.status = session.view.status;
                stored.metadata_revision = session.view.metadata_revision;
            }
        }
        Ok(response)
    }

    pub async fn read_session(&self, request: ReadSessionRequest) -> Result<ReadSessionResponse, AgentError> {
        drop(self.state()?);
        if let Some(index) = &self.index {
            let _gate = index.gate.lock().await;
            let id = parse_id(&request.session_id, "session_id")?;
            if !self.load(id).await? {
                return Ok(ReadSessionResponse::default());
            }
        }
        self.read_loaded(request)
    }

    pub async fn subscribe_session(&self, request: SubscribeSessionRequest) -> Result<EventSubscription, AgentError> {
        drop(self.state()?);
        if let Some(index) = &self.index {
            let _gate = index.gate.lock().await;
            self.require(&request.session_id).await?;
            return self.subscribe_loaded(request);
        }
        self.subscribe_loaded(request)
    }

    pub async fn start_run(
        &self,
        request: StartRunRequest,
        source: InputSource,
    ) -> Result<StartRunResponse, AgentError> {
        drop(self.state()?);
        let Some(index) = &self.index else {
            return self.start_loaded(request, source).await;
        };
        let _gate = index.gate.lock().await;
        let id = self.require(&request.session_id).await?;
        crate::input::validate(&request, &source)?;
        let initial = {
            let state = self.state()?;
            let session = &state.sessions[&id];
            if session.view.runs.is_empty() && session.view.title.is_empty() {
                let text = request
                    .input
                    .iter()
                    .filter_map(|input| match &input.content {
                        Some(agent_user_input::Content::Text(text)) => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                Some(
                    text.split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(15)
                        .collect::<String>(),
                )
            } else {
                None
            }
        };
        if let Some(title) = initial {
            self.persist_title_locked(id, title, true).await?;
        }
        let response = self.start_loaded(request, source).await?;
        self.flush_locked(id).await?;
        Ok(response)
    }

    pub async fn set_session_config(
        &self,
        request: SetSessionConfigRequest,
    ) -> Result<SetSessionConfigResponse, AgentError> {
        drop(self.state()?);
        let Some(index) = &self.index else {
            return self.set_config_loaded(request).await;
        };
        let _gate = index.gate.lock().await;
        let id = self.require(&request.session_id).await?;
        let response = self.set_config_loaded(request).await?;
        self.flush_locked(id).await?;
        Ok(response)
    }

    pub async fn set_session_title(
        &self,
        request: SetSessionTitleRequest,
    ) -> Result<SetSessionTitleResponse, AgentError> {
        drop(self.state()?);
        let Some(index) = &self.index else {
            return self.set_title_loaded(request);
        };
        let _gate = index.gate.lock().await;
        let id = self.require(&request.session_id).await?;
        let title = request.title.trim().to_owned();
        if title.is_empty() || title.chars().count() > 50 || title.chars().any(char::is_control) {
            return Err(AgentError::InvalidArgument("title"));
        }
        {
            let state = self.state()?;
            let session = &state.sessions[&id];
            if session.view.title == title && !session.view.auto_title_enabled && session.current_title_task.is_none() {
                return Ok(SetSessionTitleResponse {
                    title,
                    metadata_revision: session.view.metadata_revision,
                });
            }
        }
        self.persist_title_locked(id, title, false).await
    }

    pub(crate) async fn persist_title_locked(
        &self,
        id: SessionId,
        title: String,
        auto_title_enabled: bool,
    ) -> Result<SetSessionTitleResponse, AgentError> {
        persist_title(
            &self.state,
            self.index.as_ref().unwrap(),
            id,
            TitleUpdate {
                title,
                auto_title_enabled,
                update_activity: true,
                expected: None,
            },
        )
        .await
    }

    pub(crate) async fn flush_locked(&self, id: SessionId) -> Result<(), AgentError> {
        if let Some(index) = &self.index {
            flush(&self.state, index, id).await?;
        }
        Ok(())
    }
}

pub(crate) async fn flush(shared: &Arc<Mutex<State>>, index: &IndexAccess, id: SessionId) -> Result<(), AgentError> {
    let request = {
        let mut state = shared.lock().map_err(|_| AgentError::Internal)?;
        let Some(session) = state.sessions.get_mut(&id).filter(|s| !s.deleted()) else {
            return Ok(());
        };
        session.index_dirty = true;
        summary(session)
    };
    index.storage.update(request.clone()).await.map_err(|error| {
        log::error!("Agent directory update failed session={id} error={error}");
        error
    })?;
    let mut state = shared.lock().map_err(|_| AgentError::Internal)?;
    if let Some(session) = state.sessions.get_mut(&id) {
        session.index_dirty = false;
    }
    Ok(())
}

pub(crate) struct TitleUpdate {
    pub title: String,
    pub auto_title_enabled: bool,
    pub update_activity: bool,
    pub expected: Option<(xw_agent_types::GenId, u64)>,
}

pub(crate) async fn persist_title(
    shared: &Arc<Mutex<State>>,
    index: &IndexAccess,
    id: SessionId,
    update: TitleUpdate,
) -> Result<SetSessionTitleResponse, AgentError> {
    let TitleUpdate {
        title,
        auto_title_enabled,
        update_activity,
        expected,
    } = update;
    let request = {
        let state = shared.lock().map_err(|_| AgentError::Internal)?;
        if state.closed {
            return Err(AgentError::Closed);
        }
        let session = state
            .sessions
            .get(&id)
            .filter(|s| !s.deleted())
            .ok_or(AgentError::NotFound("session"))?;
        session.available()?;
        if expected.is_some_and(|(task, revision)| {
            session.current_title_task != Some(task) || session.view.metadata_revision != revision
        }) {
            return Err(AgentError::Conflict("title task superseded"));
        }
        let mut updated = summary(session);
        if updated.title != title || updated.auto_title_enabled != auto_title_enabled {
            updated.metadata_revision += 1;
        }
        updated.title = title.clone();
        updated.auto_title_enabled = auto_title_enabled;
        if update_activity {
            updated.updated_at_ms = updated.updated_at_ms.max(now_ms()?);
        }
        updated
    };
    let stored = index.storage.update(request.clone()).await?.summary;
    let response = SetSessionTitleResponse {
        title,
        metadata_revision: request.metadata_revision,
    };
    let mut state = shared.lock().map_err(|_| AgentError::Internal)?;
    let session = state.sessions.get_mut(&id).ok_or(AgentError::NotFound("session"))?;
    session.cancel_titles();
    session.view.title = response.title.clone();
    session.view.auto_title_enabled = auto_title_enabled;
    session.view.metadata_revision = request.metadata_revision;
    session.view.updated_at_ms = session.view.updated_at_ms.max(stored.updated_at_ms);
    AgentService::publish(
        &mut state,
        AgentEvent {
            emitted_at_ms: now_ms()?,
            payload: Some(agent_event::Payload::SessionTitleUpdated(SessionTitleUpdated {
                session_id: id.to_string(),
                title: response.title.clone(),
                auto_title_enabled,
                metadata_revision: response.metadata_revision,
                updated_at_ms: stored.updated_at_ms,
                title_model_ref: String::new(),
            })),
        },
    );
    log::debug!(
        "Agent title persisted session={id} auto_title_enabled={auto_title_enabled} revision={}",
        response.metadata_revision
    );
    Ok(response)
}

impl AgentService {
    pub async fn regenerate_title(
        &self,
        request: RegenerateTitleRequest,
    ) -> Result<RegenerateTitleResponse, AgentError> {
        drop(self.state()?);
        if let Some(index) = &self.index {
            let _gate = index.gate.lock().await;
            self.require(&request.session_id).await?;
        }
        self.regenerate_loaded(request).await
    }

    pub(crate) fn freeze(&self, id: SessionId) -> Result<Vec<crate::CancellationToken>, AgentError> {
        let mut state = self.state()?;
        let Some(session) = state.sessions.get_mut(&id) else {
            return Ok(Vec::new());
        };
        if session.frozen {
            return Err(AgentError::Conflict("session is closing"));
        }
        session.frozen = true;
        session.cancel_titles();
        let mut done = session
            .title_tasks
            .values()
            .map(|task| task.done.clone())
            .collect::<Vec<_>>();
        if let Some(active) = &session.active {
            active.cancellation.cancel();
            done.push(active.done.clone());
        }
        Ok(done)
    }

    fn unfreeze(&self, id: SessionId) {
        if let Ok(mut state) = self.state.lock()
            && let Some(session) = state.sessions.get_mut(&id)
        {
            session.frozen = false;
        }
    }

    pub async fn set_session_archived(
        &self,
        request: SetSessionArchivedRequest,
    ) -> Result<SetSessionArchivedResponse, AgentError> {
        self.archive_session_before(request, None).await
    }

    pub(crate) async fn archive_session_before(
        &self,
        request: SetSessionArchivedRequest,
        cutoff: Option<i64>,
    ) -> Result<SetSessionArchivedResponse, AgentError> {
        drop(self.state()?);
        let index = self.index.as_ref().ok_or(AgentError::Index)?;
        let id: SessionId = parse_id(&request.session_id, "session_id")?;
        if request.expected_archive_revision == 0 {
            return Err(AgentError::InvalidArgument("expected_archive_revision"));
        }
        let (done, _ownership) = {
            let _gate = index.gate.lock().await;
            let record = index
                .storage
                .get(&request.session_id)
                .await?
                .filter(|r| !r.deleting)
                .ok_or(AgentError::NotFound("session"))?;
            if let Some(cutoff) = cutoff {
                let mut state = self.state()?;
                if let Some(viewers) = state.viewers.get_mut(&id) {
                    viewers.retain(|viewer| viewer.strong_count() > 0);
                    if viewers.is_empty() {
                        state.viewers.remove(&id);
                    }
                }
                let busy = state.sessions.get(&id).is_some_and(|session| {
                    session.active.is_some()
                        || !session.title_tasks.is_empty()
                        || session.index_dirty
                        || session.view.updated_at_ms > cutoff
                });
                if record.summary.updated_at_ms > cutoff
                    || state.viewers.get(&id).is_some_and(|viewers| !viewers.is_empty())
                    || busy
                {
                    return Err(AgentError::Conflict("session active or viewed"));
                }
            }
            let ownership = if self.state()?.sessions.contains_key(&id) {
                None
            } else {
                Some(
                    self.rollout
                        .as_ref()
                        .ok_or(AgentError::Internal)?
                        .claim_registered(id, record.summary.created_at_ms)
                        .map_err(crate::persistence::storage_error)?,
                )
            };
            let stored = record.summary;
            if request.expected_archive_revision != stored.archive_revision {
                return Err(AgentError::Conflict("archive revision"));
            }
            if stored.archived == request.archived {
                return Ok(SetSessionArchivedResponse {
                    archived: stored.archived,
                    archive_revision: stored.archive_revision,
                });
            }
            (self.freeze(id)?, ownership)
        };
        // Release the index gate while settling: run/title tasks commit through it.
        for done in done {
            done.cancelled().await;
        }
        let _gate = index.gate.lock().await;
        // A cold session has no in-memory frozen flag. A viewer may have arrived
        // while settlement released the gate; recheck before the SQL commit.
        let viewing = cutoff.is_some()
            && self
                .state()?
                .viewers
                .get(&id)
                .is_some_and(|viewers| viewers.iter().any(|viewer| viewer.strong_count() > 0));
        if viewing {
            self.unfreeze(id);
            return Err(AgentError::Conflict("session active or viewed"));
        }
        let changed_at = now_ms()?;
        let result = index.storage.set_archived_before(request, cutoff, changed_at).await;
        let response = match result {
            Ok(response) => response,
            Err(error) => {
                self.unfreeze(id);
                return Err(error);
            }
        };
        let mut state = self.state()?;
        if let Some(session) = state.sessions.get_mut(&id) {
            if !response.archived {
                session.view.updated_at_ms = session.view.updated_at_ms.max(changed_at);
            }
            session.view.archived = response.archived;
            session.view.archive_revision = response.archive_revision;
        }
        Self::publish(
            &mut state,
            AgentEvent {
                emitted_at_ms: now_ms()?,
                payload: Some(agent_event::Payload::SessionArchivedUpdated(SessionArchivedUpdated {
                    session_id: id.to_string(),
                    archived: response.archived,
                    archive_revision: response.archive_revision,
                })),
            },
        );
        if response.archived {
            finish_observers(&mut state, &id.to_string());
            state.sessions.remove(&id);
            state.creations.retain(|_, (session_id, _)| *session_id != id);
        } else if let Some(session) = state.sessions.get_mut(&id) {
            session.frozen = false;
        }
        log::debug!(
            "Agent archive committed session={id} archived={} revision={}",
            response.archived,
            response.archive_revision
        );
        Ok(response)
    }

    pub async fn delete_session(&self, request: DeleteSessionRequest) -> Result<DeleteSessionResponse, AgentError> {
        drop(self.state()?);
        if request.targets.is_empty() {
            return Err(AgentError::InvalidArgument("targets"));
        }
        let mut ids = std::collections::HashSet::new();
        for target in &request.targets {
            let id: SessionId = parse_id(&target.session_id, "session_id")?;
            if !ids.insert(id) {
                return Err(AgentError::InvalidArgument("duplicate session_id"));
            }
            if target.expected_metadata_revision == 0
                || target.expected_metadata_revision > i64::MAX as u64
                || target
                    .expected_archive_revision
                    .is_some_and(|revision| revision == 0 || revision > i64::MAX as u64)
            {
                return Err(AgentError::InvalidArgument("expected revision"));
            }
        }
        let mut results = Vec::with_capacity(request.targets.len());
        let mut stopped = false;
        for target in request.targets {
            let session_id = target.session_id.clone();
            let (status, error) = if stopped {
                (DeleteSessionStatus::NotExecuted, String::new())
            } else {
                match self.delete_target(target).await {
                    Ok(true) => (DeleteSessionStatus::Deleted, String::new()),
                    Ok(false) => (DeleteSessionStatus::Skipped, "会话已不存在".into()),
                    Err(AgentError::Conflict(
                        reason @ ("metadata revision"
                        | "archive revision"
                        | "session not archived"
                        | "session directory revision or identity"),
                    )) => {
                        log::debug!("Agent deletion skipped session={session_id} reason={reason}");
                        (
                            DeleteSessionStatus::Skipped,
                            "会话状态或版本已变化，请刷新后重试".into(),
                        )
                    }
                    Err(error) => {
                        log::error!("Agent deletion failed session={session_id} error={error}");
                        stopped = true;
                        (DeleteSessionStatus::Failed, error.to_string())
                    }
                }
            };
            results.push(DeleteSessionResult {
                session_id,
                status: status.into(),
                error,
            });
        }
        log::debug!(
            "Agent deletion batch settled targets={} stopped={stopped}",
            results.len()
        );
        Ok(DeleteSessionResponse { results })
    }

    async fn delete_target(&self, request: DeleteSessionTarget) -> Result<bool, AgentError> {
        drop(self.state()?);
        let Some(index) = &self.index else {
            return self.delete_loaded(request).await;
        };
        let id: SessionId = parse_id(&request.session_id, "session_id")?;
        if request.expected_metadata_revision == 0 {
            return Err(AgentError::InvalidArgument("expected_metadata_revision"));
        }
        let (record, done, ownership) = {
            let _gate = index.gate.lock().await;
            let Some(record) = index.storage.get(&request.session_id).await? else {
                return Ok(false);
            };
            let stored = &record.summary;
            if !record.deleting
                && let Some(expected) = request.expected_archive_revision
            {
                if !stored.archived {
                    return Err(AgentError::Conflict("session not archived"));
                }
                if expected != stored.archive_revision {
                    return Err(AgentError::Conflict("archive revision"));
                }
            }
            let revision = self
                .state()?
                .sessions
                .get(&id)
                .map_or(stored.metadata_revision, |s| s.view.metadata_revision);
            if !record.deleting && request.expected_metadata_revision != revision {
                return Err(AgentError::Conflict("metadata revision"));
            }
            let ownership = if self.state()?.sessions.contains_key(&id) {
                None
            } else {
                Some(
                    self.rollout
                        .as_ref()
                        .ok_or(AgentError::Internal)?
                        .claim_registered(id, stored.created_at_ms)
                        .map_err(crate::persistence::storage_error)?,
                )
            };
            let done = if record.deleting { Vec::new() } else { self.freeze(id)? };
            (record, done, ownership)
        };
        for done in done {
            done.cancelled().await;
        }
        let _gate = index.gate.lock().await;
        if let Err(error) = index
            .storage
            .mark_deleting(&id.to_string(), request.expected_archive_revision)
            .await
        {
            self.unfreeze(id);
            return Err(error);
        }
        {
            let mut state = self.state()?;
            if let Some(session) = state.sessions.get_mut(&id) {
                session.delete();
            }
            Self::publish(
                &mut state,
                AgentEvent {
                    emitted_at_ms: now_ms()?,
                    payload: Some(agent_event::Payload::SessionDeleted(SessionDeleted {
                        session_id: id.to_string(),
                    })),
                },
            );
            finish_observers(&mut state, &id.to_string());
            state.sessions.remove(&id); // releases file ownership before direct cleanup
            state.creations.retain(|_, (session_id, _)| *session_id != id);
        }
        if let Some(ownership) = ownership {
            ownership.delete().map_err(crate::persistence::storage_error)?;
            index.storage.remove(id.to_string()).await?;
        } else {
            self.cleanup_record(&record).await?;
        }
        log::debug!("Agent session deleted session={id}");
        Ok(true)
    }

    async fn cleanup_record(&self, record: &AgentIndexRecord) -> Result<(), AgentError> {
        let summary = &record.summary;
        let id = parse_id(&summary.session_id, "session_id")?;
        self.rollout
            .as_ref()
            .ok_or(AgentError::Internal)?
            .delete_registered(id, summary.created_at_ms)
            .map_err(crate::persistence::storage_error)?;
        self.index
            .as_ref()
            .ok_or(AgentError::Index)?
            .storage
            .remove(summary.session_id.clone())
            .await
    }

    /// Called when opening the core. Queries only deleting
    /// rows and their registered paths; ordinary histories are never scanned.
    pub(crate) async fn finish_pending_deletions(&self) -> Result<(), AgentError> {
        let Some(index) = &self.index else { return Ok(()) };
        let _gate = index.gate.lock().await;
        let records = index.storage.list_deleting().await?;
        for record in records {
            if let Err(error) = self.cleanup_record(&record).await {
                log::error!(
                    "Agent pending deletion failed session={} error={error}",
                    record.summary.session_id.as_str()
                );
                // A known file cleanup failure does not prevent other conversations.
                // The deleting row remains hidden and retries on the next activation.
            }
        }
        Ok(())
    }
}

fn finish_observers(state: &mut State, id: &str) {
    for observer in state.observers.iter().filter_map(|observer| observer.upgrade()) {
        observer.finish_session(id);
    }
}
