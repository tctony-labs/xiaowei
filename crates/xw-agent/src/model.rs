use std::sync::{Arc, Mutex};

use xw_agent_types::{ModelInfo, ModelInfoError, SessionId};

use crate::{
    AgentError, AgentHost, AgentService,
    protocol::*,
    service::{State, now_ms},
    session::{Session, parse_id},
};

impl AgentService {
    pub(crate) async fn set_config_loaded(
        &self,
        request: SetSessionConfigRequest,
    ) -> Result<SetSessionConfigResponse, AgentError> {
        let id: SessionId = parse_id(&request.session_id, "session_id")?;
        let config = request.config.ok_or(AgentError::InvalidArgument("config"))?;
        crate::input::validate_config(&config)?;
        if request.expected_metadata_revision == 0 {
            return Err(AgentError::InvalidArgument("expected_metadata_revision"));
        }
        // Query outside the state lock. Revision is rechecked before committing.
        let info = self.host.get_model_info(config.model_ref.clone()).await;
        let mut state = self.state()?;
        let session = state
            .sessions
            .get_mut(&id)
            .filter(|s| !s.deleted())
            .ok_or(AgentError::NotFound("session"))?;
        session.available()?;
        if session.view.metadata_revision != request.expected_metadata_revision {
            return Err(AgentError::Conflict("metadata revision"));
        }
        session.prepare_writer()?;
        let previous_view = session.view.clone();
        let previous_info = session.model_info.clone();
        let changed_model = session
            .view
            .config
            .as_ref()
            .is_none_or(|old| old.model_ref != config.model_ref);
        if session.view.config.as_ref() != Some(&config) {
            session.view.config = Some(config.clone());
            session.view.metadata_revision += 1;
            if changed_model {
                session.view.provider_name.clear();
                session.view.model_name.clear();
            }
        }
        session.model_query += 1;
        apply_info(session, &config.model_ref, info);
        if session.view.metadata_revision == previous_view.metadata_revision
            && (session.view.provider_name != previous_view.provider_name
                || session.view.model_name != previous_view.model_name)
        {
            session.view.metadata_revision += 1;
        }
        let view = session.view.clone();
        if let Err(error) = session.commit_meta(&view) {
            session.view = previous_view;
            session.model_info = previous_info;
            return Err(error);
        }
        let revision = session.view.metadata_revision;
        let config_event = SessionConfigUpdated {
            session_id: id.to_string(),
            config: Some(config),
            provider_name: session.view.provider_name.clone(),
            model_name: session.view.model_name.clone(),
            metadata_revision: revision,
        };
        let warning = warning_event(session);
        Self::publish(
            &mut state,
            event(agent_event::Payload::SessionConfigUpdated(config_event)),
        );
        Self::publish(
            &mut state,
            event(agent_event::Payload::SessionModelInfoWarningUpdated(warning)),
        );
        log::debug!("Agent session config updated session={id} revision={revision}");
        Ok(SetSessionConfigResponse {
            metadata_revision: revision,
        })
    }

    pub(crate) fn refresh_model_info(&self, id: SessionId) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let query = {
            let Ok(mut state) = self.state() else { return };
            let Some(session) = state.sessions.get_mut(&id).filter(|s| !s.deleted()) else {
                return;
            };
            let Some(config) = &session.view.config else { return };
            let model_ref = config.model_ref.clone();
            session.model_query += 1;
            (model_ref, session.model_query)
        };
        let shared = self.state.clone();
        let host = self.host.clone();
        handle.spawn(refresh(shared, host, id, query));
    }
}

async fn refresh(shared: Arc<Mutex<State>>, host: Arc<dyn AgentHost>, id: SessionId, query: (String, u64)) {
    let info = host.get_model_info(query.0.clone()).await;
    let mut state = shared.lock().unwrap();
    if state.closed {
        return;
    }
    let Some(session) = state.sessions.get_mut(&id).filter(|s| !s.deleted()) else {
        return;
    };
    if session.model_query != query.1 || session.view.config.as_ref().is_none_or(|c| c.model_ref != query.0) {
        return;
    }
    apply_info(session, &query.0, info);
    let update = warning_event(session);
    AgentService::publish(
        &mut state,
        event(agent_event::Payload::SessionModelInfoWarningUpdated(update)),
    );
}

pub(crate) fn validate_info(model_ref: &str, info: ModelInfo) -> Result<ModelInfo, ModelInfoError> {
    if info.model_ref != model_ref
        || info.provider_name.trim().is_empty()
        || info.model_name.trim().is_empty()
        || info.capabilities.context_window == 0
        || info.capabilities.max_output_tokens == 0
        || info.capabilities.max_output_tokens > info.capabilities.context_window
    {
        Err(ModelInfoError::InvalidResponse)
    } else {
        Ok(info)
    }
}

pub(crate) fn apply_info(session: &mut Session, model_ref: &str, info: Result<ModelInfo, ModelInfoError>) {
    let info = info.and_then(|info| validate_info(model_ref, info));
    match info {
        Ok(info) => {
            session.view.provider_name = info.provider_name.clone();
            session.view.model_name = info.model_name.clone();
            session.model_info = Some(info);
            session.view.model_info_warning = None;
        }
        Err(error) => {
            session.model_info = None;
            session.view.model_info_warning = Some(ModelInfoWarning {
                model_ref: model_ref.to_owned(),
                code: match error {
                    ModelInfoError::NotFound => ModelInfoWarningCode::NotFound,
                    ModelInfoError::Unavailable => ModelInfoWarningCode::Unavailable,
                    ModelInfoError::InvalidResponse => ModelInfoWarningCode::InvalidResponse,
                }
                .into(),
            });
            log::debug!(
                "Agent model info unavailable session={} model_ref={model_ref} reason={error}",
                session.view.session_id
            );
        }
    }
}

pub(crate) fn warning_event(session: &Session) -> SessionModelInfoWarningUpdated {
    SessionModelInfoWarningUpdated {
        session_id: session.view.session_id.clone(),
        warning: session.view.model_info_warning.clone(),
        provider_name: session.view.provider_name.clone(),
        model_name: session.view.model_name.clone(),
    }
}

fn event(payload: agent_event::Payload) -> AgentEvent {
    AgentEvent {
        emitted_at_ms: now_ms().unwrap_or_default(),
        payload: Some(payload),
    }
}
