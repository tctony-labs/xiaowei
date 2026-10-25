use std::sync::{Arc, Mutex};

use prost::Message;
use tokio::sync::Notify;
use xw_agent_runtime::tools::interactive;
use xw_agent_types as domain;

use crate::{
    AgentError, AgentService, CancellationToken, InputSource,
    execution::{MAX_DISPLAY_BYTES, event},
    protocol::*,
    service::{State, now_ms},
    session::{Session, parse_id},
};

pub(crate) struct InteractionRecord {
    pub opened: domain::InteractionOpened,
    pub resolved: Option<domain::InteractionResolved>,
    pub expired: Option<domain::InteractionExpired>,
    changed: Arc<Notify>,
}

impl InteractionRecord {
    pub fn new(opened: domain::InteractionOpened) -> Self {
        Self {
            opened,
            resolved: None,
            expired: None,
            changed: Arc::new(Notify::new()),
        }
    }

    pub fn view(&self) -> AgentInteraction {
        let request = match &self.opened.request {
            domain::InteractionRequest::Question {
                question,
                options,
                multi_select,
            } => Some(agent_interaction::Request::Question(AgentQuestion {
                question: question.clone(),
                options: options.clone(),
                multi_select: *multi_select,
            })),
            domain::InteractionRequest::Permission { target, reason } => Some(
                agent_interaction::Request::Permission(AgentPermissionRequest {
                    path: target.path.clone(),
                    is_directory: target.is_directory,
                    reason: reason.clone(),
                }),
            ),
            domain::InteractionRequest::ToolExecution { .. } => None,
        };
        AgentInteraction {
            interaction_id: self.opened.interaction_id.to_string(),
            revision: if self.pending() { 1 } else { 2 },
            request,
            status: if self.resolved.is_some() {
                AgentInteractionStatus::Resolved
            } else if self.expired.is_some() {
                AgentInteractionStatus::Expired
            } else {
                AgentInteractionStatus::Pending
            }
            .into(),
            answer: self
                .resolved
                .as_ref()
                .map(|resolved| public_answer(&resolved.answer)),
            client_request_id: self
                .resolved
                .as_ref()
                .map(|r| r.client_request_id.to_string()),
            expire_reason: self.expired.as_ref().map(|expired| {
                match expired.reason {
                    domain::InteractionExpireReason::Recovery => {
                        AgentInteractionExpireReason::Recovery
                    }
                    domain::InteractionExpireReason::SessionClosing => {
                        AgentInteractionExpireReason::SessionClosing
                    }
                    _ => AgentInteractionExpireReason::Stopped,
                }
                .into()
            }),
        }
    }

    pub fn pending(&self) -> bool {
        self.resolved.is_none() && self.expired.is_none()
    }
}

fn public_answer(answer: &domain::InteractionAnswer) -> AgentInteractionAnswer {
    AgentInteractionAnswer {
        answer: match answer {
            domain::InteractionAnswer::Question {
                selected_indices,
                text,
            } => Some(agent_interaction_answer::Answer::Question(
                AgentQuestionAnswer {
                    selected_indices: selected_indices.clone(),
                    text: text.clone(),
                },
            )),
            domain::InteractionAnswer::Permission { allow } => {
                Some(agent_interaction_answer::Answer::Permission(
                    AgentPermissionAnswer { allow: *allow },
                ))
            }
            domain::InteractionAnswer::ToolExecution { .. } => None,
        },
    }
}

fn domain_answer(answer: &AgentInteractionAnswer) -> Result<domain::InteractionAnswer, AgentError> {
    match &answer.answer {
        Some(agent_interaction_answer::Answer::Question(answer)) => {
            Ok(domain::InteractionAnswer::Question {
                selected_indices: answer.selected_indices.clone(),
                text: answer.text.clone(),
            })
        }
        Some(agent_interaction_answer::Answer::Permission(answer)) => {
            Ok(domain::InteractionAnswer::Permission {
                allow: answer.allow,
            })
        }
        None => Err(AgentError::InvalidArgument("answer")),
    }
}

pub(crate) fn project(session: &mut Session, id: domain::InteractionId) {
    let record = &session.interactions[&id];
    let view = record.view();
    if let Some(tool) = session
        .view
        .runs
        .iter_mut()
        .flat_map(|run| &mut run.items)
        .filter_map(|item| match &mut item.content {
            Some(agent_item::Content::ToolCall(tool)) => Some(tool),
            _ => None,
        })
        .find(|tool| tool.tool_id == record.opened.tool_id.to_string())
    {
        tool.interaction = Some(view);
    }
}

fn publish(state: &mut State, session_id: domain::SessionId, id: domain::InteractionId) {
    let session = state.sessions.get_mut(&session_id).unwrap();
    project(session, id);
    let record = &session.interactions[&id];
    let update = InteractionUpdated {
        session_id: session_id.to_string(),
        run_id: record.opened.run_id.to_string(),
        tool_id: record.opened.tool_id.to_string(),
        interaction: Some(record.view()),
    };
    record.changed.notify_one();
    AgentService::publish(
        state,
        event(agent_event::Payload::InteractionUpdated(update)),
    );
}

pub(crate) async fn wait(
    shared: &Mutex<State>,
    session_id: domain::SessionId,
    intent: &domain::ToolIntent,
    request: domain::InteractionRequest,
    cancellation: &CancellationToken,
) -> Result<Option<domain::InteractionAnswer>, AgentError> {
    let id = domain::InteractionId::new();
    let changed = {
        let mut state = shared.lock().unwrap();
        if cancellation.is_cancelled() {
            return Ok(None);
        }
        let session = state
            .sessions
            .get_mut(&session_id)
            .ok_or(AgentError::Internal)?;
        let opened = domain::InteractionOpened {
            interaction_id: id,
            revision: 1,
            run_id: intent.key.run_id,
            tool_id: intent.tool_id,
            request,
        };
        if session.view.encoded_len() + serde_json::to_vec(&opened).unwrap().len()
            > MAX_DISPLAY_BYTES - 2048
        {
            return Err(AgentError::ResourceExhausted("interaction snapshot"));
        }
        session.append(
            domain::EntryPayload::InteractionOpened(opened.clone()),
            now_ms()?,
        )?;
        let record = InteractionRecord::new(opened);
        let changed = record.changed.clone();
        session.interactions.insert(id, record);
        publish(&mut state, session_id, id);
        log::debug!(
            "Agent interaction opened session={session_id} tool={} interaction={id}",
            intent.tool_id
        );
        changed
    };
    loop {
        let notified = changed.notified();
        {
            let mut state = shared.lock().unwrap();
            let session = state
                .sessions
                .get_mut(&session_id)
                .ok_or(AgentError::Internal)?;
            let record = &session.interactions[&id];
            if let Some(resolved) = &record.resolved {
                return Ok(Some(resolved.answer.clone()));
            }
            if record.expired.is_some() {
                return Ok(None);
            }
            if cancellation.is_cancelled() {
                let reason = if state.closed
                    || state.sessions[&session_id].deleted()
                    || state.sessions[&session_id].frozen
                {
                    domain::InteractionExpireReason::SessionClosing
                } else {
                    domain::InteractionExpireReason::Stopped
                };
                let expired = domain::InteractionExpired {
                    interaction_id: id,
                    revision: 2,
                    reason,
                    preempting_input_id: None,
                };
                let session = state.sessions.get_mut(&session_id).unwrap();
                let committed = session.append(
                    domain::EntryPayload::InteractionExpired(expired.clone()),
                    now_ms()?,
                );
                session.interactions.get_mut(&id).unwrap().expired = Some(expired);
                publish(&mut state, session_id, id);
                committed?;
                log::debug!("Agent interaction expired session={session_id} interaction={id}");
                return Ok(None);
            }
        }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {}
            _ = notified => {}
        }
    }
}

impl AgentService {
    pub async fn respond_interaction(
        &self,
        request: RespondInteractionRequest,
        source: InputSource,
    ) -> Result<RespondInteractionResponse, AgentError> {
        let session_id = parse_id(&request.session_id, "session_id")?;
        let id = parse_id(&request.interaction_id, "interaction_id")?;
        let client_request_id = parse_id(&request.client_request_id, "client_request_id")?;
        if request.expected_revision != 1
            || source.principal_id.trim().is_empty()
            || source.principal_id.len() > 1024
        {
            return Err(AgentError::InvalidArgument("revision or caller"));
        }
        let answer = domain_answer(
            request
                .answer
                .as_ref()
                .ok_or(AgentError::InvalidArgument("answer"))?,
        )?;
        self.read_session(ReadSessionRequest {
            session_id: request.session_id,
            include_runs: false,
        })
        .await?;
        let mut state = self.state()?;
        let session = state
            .sessions
            .get_mut(&session_id)
            .ok_or(AgentError::NotFound("session"))?;
        session.available()?;
        let record = session
            .interactions
            .get(&id)
            .ok_or(AgentError::NotFound("interaction"))?;
        if let Some(previous) = &record.resolved {
            if previous.client_request_id == client_request_id
                && previous.source == source
                && previous.answer == answer
            {
                return Ok(RespondInteractionResponse {
                    interaction: Some(record.view()),
                });
            }
            return Err(AgentError::Conflict("interaction already resolved"));
        }
        if !record.pending()
            || session.deleted()
            || session.active.as_ref().is_none_or(|run| {
                run.run_id != record.opened.run_id || run.cancellation.is_cancelled()
            })
        {
            return Err(AgentError::Conflict("interaction expired or run stopped"));
        }
        let output = interactive::result(&record.opened.request, &answer)
            .map_err(|_| AgentError::InvalidArgument("answer"))?;
        if session.view.encoded_len()
            + output.text.len()
            + request.answer.as_ref().unwrap().encoded_len()
            > MAX_DISPLAY_BYTES - 2048
        {
            return Err(AgentError::ResourceExhausted("interaction answer"));
        }
        let opened = record.opened.clone();
        let resolved = domain::InteractionResolved {
            interaction_id: id,
            revision: 2,
            client_request_id,
            source,
            answer,
        };
        if let Err(error) = session.append(
            domain::EntryPayload::InteractionResolved(resolved.clone()),
            now_ms()?,
        ) {
            if let Some(active) = &session.active {
                active.cancellation.cancel();
            }
            return Err(error);
        }
        if let (
            domain::InteractionRequest::Permission { target, .. },
            domain::InteractionAnswer::Permission { allow: true },
        ) = (&opened.request, &resolved.answer)
            && !session.granted_paths.contains(target)
        {
            session.granted_paths.push(target.clone());
        }
        session.interactions.get_mut(&id).unwrap().resolved = Some(resolved);
        let interaction = session.interactions[&id].view();
        publish(&mut state, session_id, id);
        log::debug!("Agent interaction resolved session={session_id} interaction={id}");
        Ok(RespondInteractionResponse {
            interaction: Some(interaction),
        })
    }
}
