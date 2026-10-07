use std::str::FromStr;

use xw_agent_types::SessionId;

use crate::{AgentError, protocol::*};

pub(crate) const MAX_SESSIONS: usize = 16;
pub(crate) const MAX_CREATIONS: usize = 1024;

pub(crate) fn parse_id<T: FromStr>(value: &str, field: &'static str) -> Result<T, AgentError> {
    value.parse().map_err(|_| AgentError::InvalidArgument(field))
}

pub(crate) struct Session {
    pub indexed: bool,
    pub frozen: bool,
    pub index_dirty: bool,
    pub view: AgentSession,
    pub model_info: Option<xw_agent_types::ModelInfo>,
    pub model_query: u64,
    pub journal: Option<xw_agent_rollout::Journal>,
    pub meta: Option<xw_agent_types::SessionMeta>,
    pub failed_run: Option<xw_agent_types::RunId>,
    pub deletion_announced: bool,
    pub history: Vec<xw_agent_types::AgentMessage>,
    pub requests: std::collections::BTreeMap<xw_agent_types::InputId, StartRunRequest>,
    pub active: Option<ActiveRun>,
    pub title_tasks: std::collections::BTreeMap<xw_agent_types::GenId, TitleTask>,
    pub current_title_task: Option<xw_agent_types::GenId>,
}

impl Session {
    pub fn new(id: SessionId, created_at_ms: i64, config: AgentModelConfig) -> Self {
        Self {
            indexed: false,
            frozen: false,
            index_dirty: false,
            journal: None,
            meta: None,
            failed_run: None,
            model_info: None,
            model_query: 0,
            view: AgentSession {
                session_id: id.to_string(),
                config: Some(config),
                status: AgentSessionStatus::Idle.into(),
                metadata_revision: 1,
                created_at_ms,
                updated_at_ms: created_at_ms,
                archive_revision: 1,
                runs: Vec::new(),
                title: String::new(),
                auto_title_enabled: true,
                title_model_ref: String::new(),
                ..Default::default()
            },
            title_tasks: Default::default(),
            current_title_task: None,
            deletion_announced: false,
            history: Vec::new(),
            requests: Default::default(),
            active: None,
        }
    }

    pub fn deleted(&self) -> bool {
        self.view.status == i32::from(AgentSessionStatus::Deleted)
    }

    pub fn available(&self) -> Result<(), AgentError> {
        if self.frozen || self.view.archived {
            return Err(AgentError::SessionUnavailable);
        }
        Ok(())
    }

    pub fn delete(&mut self) {
        self.cancel_titles();
        self.view.status = AgentSessionStatus::Deleted.into();
    }

    pub fn cancel_titles(&mut self) {
        for task in self.title_tasks.values() {
            task.cancellation.cancel();
        }
        self.current_title_task = None;
    }
}

pub(crate) struct TitleTask {
    pub cancellation: crate::CancellationToken,
    pub done: crate::CancellationToken,
}

pub(crate) struct ActiveRun {
    pub run_id: xw_agent_types::RunId,
    pub cancellation: crate::CancellationToken,
    pub done: crate::CancellationToken,
}
