use std::collections::BTreeMap;

use prost::Message;
use xw_agent_runtime::{GenerationRequest, RunRequest};
use xw_agent_types::{
    AgentMessage as ModelMessage, BlockId, ContentBlock, GenId, InputId, MessageId, RunId,
    SessionId, TurnId, UserMessage,
};

use crate::{
    AgentError, AgentService, CancellationToken, GenerationEvent, InputSource, input,
    protocol::*,
    service::now_ms,
    session::{ActiveRun, parse_id},
};

pub(crate) const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_DISPLAY_BYTES: usize = 8 * 1024 * 1024;

impl AgentService {
    pub(crate) async fn start_loaded(
        &self,
        mut request: StartRunRequest,
        source: InputSource,
    ) -> Result<StartRunResponse, AgentError> {
        request.title_model_ref = None;
        let id = input::validate(&request, &source)?;
        let input_id: InputId = parse_id(&request.input_id, "input_id")?;
        let config = {
            let state = self.state()?;
            let session = state
                .sessions
                .get(&id)
                .filter(|s| !s.deleted())
                .ok_or(AgentError::NotFound("session"))?;
            if let Some(original) = session.requests.get(&input_id) {
                if original != &request {
                    return Err(AgentError::Conflict("input identity"));
                }
                let run = session
                    .view
                    .runs
                    .iter()
                    .find(|run| run.input_id == request.input_id)
                    .cloned()
                    .ok_or(AgentError::Conflict("input accepted without a run"))?;
                return Ok(StartRunResponse { run: Some(run) });
            }
            request
                .config
                .clone()
                .or_else(|| session.view.config.clone())
                .ok_or(AgentError::Internal)?
        };
        let info = self.host.get_model_info(config.model_ref.clone()).await;
        self.accept_run(request, source, config, info)
    }

    fn accept_run(
        &self,
        request: StartRunRequest,
        source: InputSource,
        config: AgentModelConfig,
        info: Result<xw_agent_types::ModelInfo, xw_agent_types::ModelInfoError>,
    ) -> Result<StartRunResponse, AgentError> {
        let id = input::validate(&request, &source)?;
        let input_id: InputId = parse_id(&request.input_id, "input_id")?;
        let mut state = self.state()?;
        let session = state
            .sessions
            .get_mut(&id)
            .filter(|s| !s.deleted())
            .ok_or(AgentError::NotFound("session"))?;
        session.available()?;
        session.prepare_writer()?;
        if let Some(original) = session.requests.get(&input_id) {
            if original != &request {
                return Err(AgentError::Conflict("input identity"));
            }
            let run = session
                .view
                .runs
                .iter()
                .find(|run| run.input_id == request.input_id)
                .cloned()
                .ok_or(AgentError::Conflict("input accepted without a run"))?;
            return Ok(StartRunResponse { run: Some(run) });
        }
        if session.active.is_some() {
            return Err(AgentError::Conflict("session is running"));
        }
        if crate::tool_registry::has_unclosed_calls(&session.history) {
            return Err(AgentError::Conflict(
                "previous tool results remain unresolved",
            ));
        }
        if session.requests.len() >= 1024 {
            return Err(AgentError::ResourceExhausted("run identities"));
        }
        let retained_request_bytes = session
            .requests
            .values()
            .map(Message::encoded_len)
            .sum::<usize>();
        if session.view.encoded_len()
            + request
                .input
                .iter()
                .map(|i| match &i.content {
                    Some(agent_user_input::Content::Text(t)) => t.len(),
                    _ => 0,
                })
                .sum::<usize>()
            + 2048
            > MAX_DISPLAY_BYTES
        {
            return Err(AgentError::ResourceExhausted("display history"));
        }
        let handle =
            tokio::runtime::Handle::try_current().map_err(|_| AgentError::ExecutionUnavailable)?;
        if request.config.is_none() && session.view.config.as_ref() != Some(&config) {
            return Err(AgentError::Conflict("session config changed"));
        }
        let info = info.and_then(|info| crate::model::validate_info(&config.model_ref, info));
        let queried = info.as_ref().ok().cloned();
        if session.view.config.as_ref() == Some(&config) {
            session.model_query += 1;
            crate::model::apply_info(session, &config.model_ref, info);
            if let Some(meta) = &session.meta
                && (meta.provider_name.as_deref().unwrap_or_default() != session.view.provider_name
                    || meta.model_name.as_deref().unwrap_or_default() != session.view.model_name)
            {
                let previous_revision = session.view.metadata_revision;
                session.view.metadata_revision += 1;
                let view = session.view.clone();
                if let Err(error) = session.commit_meta(&view) {
                    session.view.metadata_revision = previous_revision;
                    return Err(error);
                }
            }
        }
        let run_id = RunId::new();
        let started_at_ms = now_ms()?;
        session.view.updated_at_ms = started_at_ms;
        let user = ModelMessage::User(UserMessage {
            content: request
                .input
                .iter()
                .map(|i| match &i.content {
                    Some(agent_user_input::Content::Text(text)) => ContentBlock::Text {
                        text: text.clone(),
                        signature: None,
                    },
                    _ => unreachable!("validated text input"),
                })
                .collect(),
            timestamp_ms: started_at_ms,
        });
        crate::tool_registry::synchronize(session, started_at_ms)?;
        let mut history = session.history.clone();
        history.push(user);
        let history_bytes = serde_json::to_vec(&history)
            .map_err(|_| AgentError::Internal)?
            .len();
        if history_bytes + retained_request_bytes + request.encoded_len() > MAX_HISTORY_BYTES {
            return Err(AgentError::ResourceExhausted(
                "model history and input identities",
            ));
        }
        let mut run = AgentRun {
            run_id: run_id.to_string(),
            input_id: input_id.to_string(),
            status: AgentRunStatus::InProgress.into(),
            config: Some(config.clone()),
            provider_name: queried
                .as_ref()
                .map(|info| info.provider_name.clone())
                .unwrap_or_default(),
            model_name: queried
                .as_ref()
                .map(|info| info.model_name.clone())
                .unwrap_or_default(),
            started_at_ms,
            items: vec![AgentItem {
                item_id: BlockId::new().to_string(),
                gen_id: None,
                content: Some(agent_item::Content::UserMessage(AgentUserMessage {
                    content: request.input.clone(),
                })),
            }],
            ..Default::default()
        };
        let execution = RunRequest {
            session_id: id,
            input_id,
            run_id,
            turn_id: TurnId::new(),
            gen_id: GenId::new(),
            message_id: MessageId::new(),
            generation: GenerationRequest {
                session_id: id,
                model_ref: config.model_ref,
                reasoning: config.reasoning,
                temperature: None,
                max_tokens: None,
                system_prompt: String::new(),
                messages: history.clone(),
            },
        };
        run.generation = Some(AgentGeneration {
            gen_id: execution.gen_id.to_string(),
            started_at_ms,
            ..Default::default()
        });
        let budget = queried
            .as_ref()
            .map(|info| xw_agent_types::ModelBudget {
                context_window: info.capabilities.context_window,
                max_output_tokens: info.capabilities.max_output_tokens,
                source: xw_agent_types::BudgetSource::Host,
            })
            .unwrap_or_default();
        let descriptor = xw_agent_types::ModelDescriptor {
            model_ref: execution.generation.model_ref.clone(),
            provider_name: queried.as_ref().map(|info| info.provider_name.clone()),
            model_name: queried.as_ref().map(|info| info.model_name.clone()),
            capabilities: queried.map(|info| info.capabilities),
            budget,
        };
        if let Err(error) = session.record_start(
            &request,
            source,
            &execution,
            run.items[0]
                .item_id
                .parse()
                .map_err(|_| AgentError::Internal)?,
            descriptor,
        ) {
            session.failed_run = Some(run_id);
            return Err(error);
        }
        let cancellation = CancellationToken::new();
        let done = CancellationToken::new();
        session.active = Some(ActiveRun {
            run_id,
            cancellation: cancellation.clone(),
            done: done.clone(),
        });
        session.history = history;
        session.cancel_titles();
        session.requests.insert(input_id, request);
        session.view.status = AgentSessionStatus::Running.into();
        session.view.runs.push(run.clone());
        let warning = crate::model::warning_event(session);
        let revision = session.view.metadata_revision;
        let title_model_ref = session.view.title_model_ref.clone();
        Self::publish(
            &mut state,
            event(agent_event::Payload::SessionModelInfoWarningUpdated(
                warning,
            )),
        );
        Self::publish(
            &mut state,
            event(agent_event::Payload::RunStarted(RunStarted {
                session_id: id.to_string(),
                run: Some(run.clone()),
                session_metadata_revision: revision,
                title_model_ref,
            })),
        );
        let shared = self.state.clone();
        let index = self.index.clone();
        let generation = self.generation.clone();
        let host = self.host.clone();
        handle.spawn(crate::run_loop::execute(
            shared,
            index,
            host,
            generation,
            execution,
            cancellation,
            done,
        ));
        log::debug!("Agent Run accepted session={id} input={input_id} run={run_id}");
        Ok(StartRunResponse { run: Some(run) })
    }
}

pub(crate) fn event(payload: agent_event::Payload) -> AgentEvent {
    AgentEvent {
        emitted_at_ms: now_ms().unwrap_or_default(),
        payload: Some(payload),
    }
}

pub(crate) fn display_item(
    item_id: String,
    gen_id: String,
    block: &ContentBlock,
) -> Option<AgentItem> {
    let content = match block {
        ContentBlock::Text { text, .. } => {
            agent_item::Content::AgentMessage(AgentMessage { text: text.clone() })
        }
        ContentBlock::Thinking { text, .. } => {
            agent_item::Content::Reasoning(AgentReasoning { text: text.clone() })
        }
        _ => return None,
    };
    Some(AgentItem {
        item_id,
        gen_id: Some(gen_id),
        content: Some(content),
    })
}

pub(crate) fn generation_update(session_id: SessionId, run: &AgentRun) -> agent_event::Payload {
    agent_event::Payload::GenerationUpdated(GenerationUpdated {
        session_id: session_id.to_string(),
        run_id: run.run_id.clone(),
        generation: run.generation.clone(),
    })
}

pub(crate) fn project_update(
    session_id: SessionId,
    run: &mut AgentRun,
    update: GenerationEvent,
    blocks: &mut BTreeMap<u32, (String, ContentBlock)>,
    base_items: usize,
) -> Vec<agent_event::Payload> {
    let previous_generation = run.generation.clone();
    let finished = matches!(&update, GenerationEvent::BlockFinished { .. });
    let content_received = match &update {
        GenerationEvent::BlockStarted { .. } | GenerationEvent::BlockFinished { .. } => true,
        GenerationEvent::TextDelta { text, .. } | GenerationEvent::ThinkingDelta { text, .. } => {
            !text.is_empty()
        }
        GenerationEvent::ToolCallDelta { .. } => true,
        _ => false,
    };
    if content_received && let Some(generation) = &mut run.generation {
        generation.received_content = true;
        if matches!(&update, GenerationEvent::ToolCallDelta { .. }) {
            generation.active_item_id = None;
        }
    }
    let (index, delta, thinking, replacement) = match update {
        GenerationEvent::TextDelta {
            content_index,
            text,
        } => (content_index, Some(text), false, None),
        GenerationEvent::ThinkingDelta {
            content_index,
            text,
        } => (content_index, Some(text), true, None),
        GenerationEvent::BlockStarted {
            content_index,
            block,
        }
        | GenerationEvent::BlockFinished {
            content_index,
            block,
        } => (
            content_index,
            None,
            matches!(block, ContentBlock::Thinking { .. }),
            Some(block),
        ),
        _ => {
            return if run.generation != previous_generation {
                vec![generation_update(session_id, run)]
            } else {
                Vec::new()
            };
        }
    };
    let new = !blocks.contains_key(&index);
    let (item_id, block) = blocks.entry(index).or_insert_with(|| {
        (
            BlockId::new().to_string(),
            if thinking {
                ContentBlock::Thinking {
                    text: String::new(),
                    signature: None,
                    redacted: false,
                }
            } else {
                ContentBlock::Text {
                    text: String::new(),
                    signature: None,
                }
            },
        )
    });
    let mut events = Vec::new();
    let gen_id = run
        .generation
        .as_ref()
        .expect("active Generate")
        .gen_id
        .clone();
    if let Some(replacement) = replacement {
        *block = replacement;
    }
    if new && let Some(item) = display_item(item_id.clone(), gen_id.clone(), block) {
        events.push(agent_event::Payload::ItemStarted(ItemStarted {
            session_id: session_id.to_string(),
            run_id: run.run_id.clone(),
            item: Some(item),
        }));
    }
    if let Some(delta) = delta {
        match block {
            ContentBlock::Text { text, .. } | ContentBlock::Thinking { text, .. } => {
                text.push_str(&delta)
            }
            _ => return events,
        }
        if thinking {
            events.push(agent_event::Payload::ReasoningDelta(ReasoningDelta {
                session_id: session_id.to_string(),
                run_id: run.run_id.clone(),
                item_id: item_id.clone(),
                delta,
            }));
        } else {
            events.push(agent_event::Payload::AgentMessageDelta(AgentMessageDelta {
                session_id: session_id.to_string(),
                run_id: run.run_id.clone(),
                item_id: item_id.clone(),
                delta,
            }));
        }
    } else if finished && let Some(item) = display_item(item_id.clone(), gen_id.clone(), block) {
        events.push(agent_event::Payload::ItemCompleted(ItemCompleted {
            session_id: session_id.to_string(),
            run_id: run.run_id.clone(),
            item: Some(item),
        }));
    }
    if let Some(generation) = &mut run.generation {
        if finished {
            if generation.active_item_id.as_ref() == Some(item_id) {
                generation.active_item_id = None;
            }
        } else {
            generation.active_item_id = matches!(
                block,
                ContentBlock::Text { .. } | ContentBlock::Thinking { .. }
            )
            .then(|| item_id.clone());
        }
    }
    run.items.truncate(base_items);
    run.items.extend(
        blocks
            .values()
            .filter_map(|(id, block)| display_item(id.clone(), gen_id.clone(), block)),
    );
    if run.generation != previous_generation {
        events.push(generation_update(session_id, run));
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_control_and_tool_declarations_do_not_become_running_tool_items() {
        let session_id = SessionId::new();
        let mut run = AgentRun {
            generation: Some(AgentGeneration {
                gen_id: GenId::new().to_string(),
                started_at_ms: 100,
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut blocks = BTreeMap::new();
        let changes = project_update(
            session_id,
            &mut run,
            GenerationEvent::FirstSseReceived {
                received_at_ms: 200,
            },
            &mut blocks,
            0,
        );
        assert!(changes.is_empty());
        assert!(!run.generation.as_ref().unwrap().received_content);

        let changes = project_update(
            session_id,
            &mut run,
            GenerationEvent::BlockStarted {
                content_index: 0,
                block: ContentBlock::ToolCall {
                    id: "call".into(),
                    name: "Read".into(),
                    arguments_json: None,
                    thought_signature: None,
                    namespace: None,
                },
            },
            &mut blocks,
            0,
        );
        assert!(run.items.is_empty());
        assert!(run.generation.as_ref().unwrap().received_content);
        assert!(run.generation.as_ref().unwrap().active_item_id.is_none());
        assert!(matches!(
            changes.as_slice(),
            [agent_event::Payload::GenerationUpdated(_)]
        ));
    }
}
