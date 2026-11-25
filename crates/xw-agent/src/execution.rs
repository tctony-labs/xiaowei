use std::collections::BTreeMap;

use prost::Message;
use xw_agent_runtime::{GenerationRequest, RunRequest, context_budget::ContextBudget};
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
        let (config, cwd, resource_cache) = {
            let state = self.state()?;
            let session = state
                .sessions
                .get(&id)
                .filter(|s| !s.deleted())
                .ok_or(AgentError::NotFound("session"))?;
            if let Some(original) = session.requests.get(&input_id)
                && (session.dispatching != Some(input_id) || session.active.is_some())
            {
                if original != &request {
                    return Err(AgentError::Conflict("input identity"));
                }
                let run = session
                    .view
                    .runs
                    .iter()
                    .rev()
                    .find(|run| run.input_id == request.input_id)
                    .cloned()
                    .ok_or(AgentError::Conflict("input accepted without a run"))?;
                return Ok(StartRunResponse { run: Some(run) });
            }
            let config = request
                .config
                .clone()
                .or_else(|| session.view.config.clone())
                .ok_or(AgentError::Internal)?;
            (
                config,
                session.view.cwd.clone(),
                session.resource_cache.clone(),
            )
        };
        let user_root = self
            .rollout
            .as_ref()
            .map(|store| store.root().to_path_buf());
        let (skills, resources) = if cwd.is_some() || user_root.is_some() {
            let runtime = tokio::runtime::Handle::try_current()
                .map_err(|_| AgentError::ExecutionUnavailable)?;
            runtime
                .spawn_blocking(move || {
                    let cwd = cwd.as_deref().map(std::path::Path::new);
                    let skills = if cwd.is_some() {
                        xw_agent_runtime::tools::skill::snapshot(
                            user_root
                                .as_ref()
                                .map(|root| root.join("skills"))
                                .as_deref(),
                            cwd,
                        )
                    } else {
                        Default::default()
                    };
                    let resources = resource_cache
                        .lock()
                        .unwrap()
                        .snapshot(user_root.as_deref(), cwd);
                    (skills, resources)
                })
                .await
                .map_err(|_| AgentError::Internal)?
        } else {
            (Default::default(), Default::default())
        };
        let info = self.host.get_model_info(config.model_ref.clone()).await;
        self.accept_run(request, source, config, info, skills, resources)
    }

    fn accept_run(
        &self,
        request: StartRunRequest,
        source: InputSource,
        config: AgentModelConfig,
        info: Result<xw_agent_types::ModelInfo, xw_agent_types::ModelInfoError>,
        skills: xw_agent_runtime::tools::skill::SkillSnapshot,
        resources: xw_agent_runtime::resources::ResourceSnapshot,
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
        if let Some(original) = session.requests.get(&input_id)
            && (session.dispatching != Some(input_id) || session.active.is_some())
        {
            if original != &request {
                return Err(AgentError::Conflict("input identity"));
            }
            let run = session
                .view
                .runs
                .iter()
                .rev()
                .find(|run| run.input_id == request.input_id)
                .cloned()
                .ok_or(AgentError::Conflict("input accepted without a run"))?;
            return Ok(StartRunResponse { run: Some(run) });
        }
        if session.active.is_some() {
            return Err(AgentError::Conflict("session is running"));
        }
        if session
            .dispatching
            .is_some_and(|pending| pending != input_id)
        {
            return Err(AgentError::Conflict("queued input dispatching"));
        }
        let queued = if session.dispatching == Some(input_id) {
            let queued = session
                .queue
                .iter()
                .find(|entry| entry.accepted.input_id == input_id)
                .cloned()
                .ok_or(AgentError::Conflict("input not queued"))?;
            if queued.view().input != request.input {
                return Err(AgentError::Conflict("queued input changed"));
            }
            Some(queued)
        } else {
            None
        };
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
        let permission_mode = session.permission_mode;
        crate::tool_registry::prepare(session)?;
        crate::skills::prepare(session, skills)?;
        crate::resources::prepare(session, resources)?;
        let mut history = session.history.clone();
        if let Some(update) = crate::tool_registry::planned_update(session)? {
            history.push(ModelMessage::SystemContext { update });
        }
        let user = queued
            .as_ref()
            .map_or(user, |input| input.message.message.clone());
        history.push(user.clone());
        let history_bytes = serde_json::to_vec(&history)
            .map_err(|_| AgentError::Internal)?
            .len();
        if history_bytes + retained_request_bytes + request.encoded_len() > MAX_HISTORY_BYTES {
            return Err(AgentError::ResourceExhausted(
                "model history and input identities",
            ));
        }
        let tools = crate::tool_registry::synchronize(session, started_at_ms)?;
        let user_block_id = queued
            .as_ref()
            .map_or_else(BlockId::new, |entry| entry.message.block_ids[0]);
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
                item_id: user_block_id.to_string(),
                gen_id: None,
                content: Some(agent_item::Content::UserMessage(AgentUserMessage {
                    content: request.input.clone(),
                    input_id: Some(input_id.to_string()),
                })),
            }],
            ..Default::default()
        };
        let mut execution = RunRequest {
            session_id: id,
            input_id,
            run_id,
            turn_id: Some(TurnId::new()),
            gen_id: GenId::new(),
            message_id: MessageId::new(),
            generation: GenerationRequest {
                session_id: id,
                isolate_provider_session: false,
                model_ref: config.model_ref,
                reasoning: config.reasoning,
                temperature: None,
                max_tokens: None,
                system_prompt: String::new(),
                messages: Vec::new(),
            },
        };
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
        let sample = crate::compaction::previous_sample(session, &descriptor.model_ref);
        let input_budget = ContextBudget::new(
            &descriptor.budget,
            sample,
            &session.history,
            std::slice::from_ref(&user),
        );
        let defer_first_turn = crate::compaction::needs_preflight(session, &input_budget);
        let manual = session.dispatch_manual;
        let run_entry_id = match session.record_start(
            &request,
            source,
            &execution,
            user_block_id,
            descriptor.clone(),
            tools,
            queued.as_ref(),
            manual,
        ) {
            Ok(entry_id) => entry_id,
            Err(error) => {
                session.failed_run = Some(run_id);
                return Err(error);
            }
        };
        if queued.is_some() {
            run.items[0].item_id = crate::persistence::run_input_item_id(
                session,
                input_id,
                user_block_id,
                run_entry_id,
            );
        }
        let pending_first = if defer_first_turn {
            Some(user)
        } else {
            if let Err(error) = session.record_first_turn(&execution, started_at_ms) {
                session.failed_run = Some(run_id);
                return Err(error);
            }
            session.history.push(user);
            execution.generation.messages = session.history.clone();
            run.generation = Some(AgentGeneration {
                gen_id: execution.gen_id.to_string(),
                started_at_ms,
                ..Default::default()
            });
            crate::queue::finish_dispatch(session, input_id);
            None
        };
        let cancellation = CancellationToken::new();
        let done = CancellationToken::new();
        session.active = Some(ActiveRun {
            run_id,
            permission_mode,
            cancellation: cancellation.clone(),
            done: done.clone(),
            committed: false,
        });
        session.cancel_titles();
        if queued.is_none() {
            session.requests.insert(input_id, request);
        }
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
        if queued.is_some() {
            crate::queue::publish(&mut state, id);
        }
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
            self.dispatch_handle(),
            shared,
            index,
            host,
            generation,
            crate::run_loop::RunPlan {
                request: execution,
                model: descriptor,
                sample,
                pending_first,
            },
            cancellation,
            done,
        ));
        log::debug!(
            "Agent Run accepted session={id} input={input_id} run={run_id} \
             permission_mode={permission_mode:?}"
        );
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
