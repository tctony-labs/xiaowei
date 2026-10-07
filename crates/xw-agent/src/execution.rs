use std::collections::BTreeMap;

use prost::Message;
use tokio::sync::mpsc;
use xw_agent_runtime::{GenerationRequest, RunRequest, RunStatus, execute_text};
use xw_agent_types::{
    AgentMessage as ModelMessage, BlockId, ContentBlock, GenId, InputId, MessageId, RunId, SessionId, TurnId,
    UserMessage,
};

use crate::{
    AgentError, AgentService, CancellationToken, GenerationEvent, InputSource, input,
    protocol::*,
    service::now_ms,
    session::{ActiveRun, parse_id},
};

const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;
const MAX_DISPLAY_BYTES: usize = 8 * 1024 * 1024;

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
        if session.requests.len() >= 1024 {
            return Err(AgentError::ResourceExhausted("run identities"));
        }
        let retained_request_bytes = session.requests.values().map(Message::encoded_len).sum::<usize>();
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
        let handle = tokio::runtime::Handle::try_current().map_err(|_| AgentError::ExecutionUnavailable)?;
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
        let mut history = session.history.clone();
        history.push(user);
        let history_bytes = serde_json::to_vec(&history).map_err(|_| AgentError::Internal)?.len();
        if history_bytes + retained_request_bytes + request.encoded_len() > MAX_HISTORY_BYTES {
            return Err(AgentError::ResourceExhausted("model history and input identities"));
        }
        let run = AgentRun {
            run_id: run_id.to_string(),
            input_id: input_id.to_string(),
            status: AgentRunStatus::InProgress.into(),
            config: Some(config.clone()),
            provider_name: queried
                .as_ref()
                .map(|info| info.provider_name.clone())
                .unwrap_or_default(),
            model_name: queried.as_ref().map(|info| info.model_name.clone()).unwrap_or_default(),
            started_at_ms,
            items: vec![AgentItem {
                item_id: BlockId::new().to_string(),
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
            run.items[0].item_id.parse().map_err(|_| AgentError::Internal)?,
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
            event(agent_event::Payload::SessionModelInfoWarningUpdated(warning)),
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
        handle.spawn(async move {
            let _done = done.drop_guard();
            let (tx, mut rx) = mpsc::channel(32);
            let future = execute_text(execution.clone(), generation.clone(), cancellation.clone(), tx);
            tokio::pin!(future);
            let mut blocks = BTreeMap::<u32, (String, ContentBlock)>::new();
            let mut display_exhausted = false;
            let mut storage_failed = false;
            let mut outcome = loop {
                tokio::select! {
                    // Drain all accepted events before settling (including a final ready result).
                    biased;
                    Some(update) = rx.recv() => {
                        let mut state = shared.lock().unwrap();
                        if let Some(session) = state.sessions.get_mut(&id).filter(|s| !s.deleted()) {
                            if display_exhausted || storage_failed { continue; }
                            if let GenerationEvent::FirstSseReceived { received_at_ms } = &update.event
                                && session.append(xw_agent_types::EntryPayload::GenFirstSseReceived(
                                    xw_agent_types::GenFirstSseReceived { gen_id: execution.gen_id,
                                        received_at_ms: *received_at_ms }), *received_at_ms).is_err() {
                                    storage_failed = true;
                                    session.failed_run = Some(run_id);
                                    cancellation.cancel();
                                    continue;
                            }
                            let previous = session.view.runs.last().unwrap().clone();
                            let run = session.view.runs.last_mut().unwrap();
                            let changes = project_update(id, run, update.event, &mut blocks);
                            if session.view.encoded_len() > MAX_DISPLAY_BYTES - 2048 {
                                *session.view.runs.last_mut().unwrap() = previous;
                                display_exhausted = true;
                                cancellation.cancel();
                            } else {
                                for change in changes { AgentService::publish(&mut state, event(change)); }
                            }
                        }
                    }
                    outcome = &mut future => break outcome,
                }
            };
            {
                let mut state = shared.lock().unwrap();
                let Some(session) = state.sessions.get_mut(&id) else {
                    return;
                };
                if session.deleted() {
                    session.active = None;
                    return;
                }
                if display_exhausted {
                    outcome.status = RunStatus::Failed;
                    outcome.error = Some(crate::GenerationError::Failed("display history budget exceeded".into()));
                }
                let mut status = match outcome.status {
                    RunStatus::Completed => AgentRunStatus::Completed,
                    RunStatus::Failed => AgentRunStatus::Failed,
                    RunStatus::Cancelled => AgentRunStatus::Interrupted,
                };
                let mut error = outcome.error.as_ref().map(|e| e.to_string());
                // Allocate final block IDs before journaling so reopen preserves the exact UI identity.
                if let Some(message) = &outcome.message {
                    for (index, block) in message.content.iter().enumerate() {
                        blocks
                            .entry(index as u32)
                            .or_insert_with(|| (BlockId::new().to_string(), block.clone()));
                    }
                }
                if !storage_failed && session.record_end(&execution, &outcome, &blocks).is_err() {
                    storage_failed = true;
                    session.failed_run = Some(run_id);
                }
                if storage_failed {
                    status = AgentRunStatus::Failed;
                    error = Some(AgentError::Persistence.to_string());
                }
                if display_exhausted {
                    status = AgentRunStatus::Failed;
                    error = Some("display history budget exceeded".into());
                }
                let previous_items = session.view.runs.last().unwrap().items.clone();
                let message = outcome.message;
                let final_blocks = message.as_ref().map(|m| m.content.clone()).unwrap_or(outcome.partial);
                {
                    let run = session.view.runs.last_mut().unwrap();
                    run.items.truncate(1);
                    for (index, block) in final_blocks.into_iter().enumerate() {
                        let item_id = blocks
                            .get(&(index as u32))
                            .map(|(id, _)| id.clone())
                            .unwrap_or_else(|| BlockId::new().to_string());
                        if let Some(item) = display_item(item_id, &block) {
                            run.items.push(item);
                        }
                    }
                }
                if display_exhausted || session.view.encoded_len() > MAX_DISPLAY_BYTES - 2048 {
                    session.view.runs.last_mut().unwrap().items = previous_items;
                    status = AgentRunStatus::Failed;
                    error = Some("display history budget exceeded".into());
                }
                if status == AgentRunStatus::Completed
                    && let Some(message) = message
                {
                    let mut history = session.history.clone();
                    history.push(ModelMessage::Assistant(message));
                    let retained_request_bytes = session.requests.values().map(Message::encoded_len).sum::<usize>();
                    if serde_json::to_vec(&history)
                        .map_or(true, |bytes| bytes.len() + retained_request_bytes > MAX_HISTORY_BYTES)
                    {
                        status = AgentRunStatus::Failed;
                        error = Some("model history budget exceeded".into());
                    } else {
                        session.history = history;
                    }
                }
                let run = session.view.runs.last_mut().unwrap();
                run.status = status.into();
                run.completed_at_ms = Some(outcome.ended_at_ms);
                run.error = (status == AgentRunStatus::Failed).then_some(error).flatten();
                let run = run.clone();
                session.active = None;
                session.view.status = AgentSessionStatus::Idle.into();
                session.view.updated_at_ms = session.view.updated_at_ms.max(outcome.ended_at_ms);
                for item in &run.items {
                    AgentService::publish(
                        &mut state,
                        event(agent_event::Payload::ItemCompleted(ItemCompleted {
                            session_id: id.to_string(),
                            run_id: run_id.to_string(),
                            item: Some(item.clone()),
                        })),
                    );
                }
                AgentService::publish(
                    &mut state,
                    event(agent_event::Payload::RunCompleted(RunCompleted {
                        session_id: id.to_string(),
                        run: Some(run),
                    })),
                );
                log::debug!("Agent Run settled session={id} input={input_id} run={run_id} status={status:?}");
                let session = &state.sessions[&id];
                let has_output = crate::title::has_output(session.view.runs.last().unwrap());
                if !state.closed
                    && !session.frozen
                    && has_output
                    && !storage_failed
                    && session.view.auto_title_enabled
                    && let Err(error) =
                        crate::title::schedule_title(&mut state, shared.clone(), host, index.clone(), id, false)
                {
                    log::debug!("Agent automatic title skipped session={id} reason={error}");
                }
            }
            if let Some(index) = index {
                let _gate = index.gate.lock().await;
                let _ = crate::index::flush(&shared, &index, id).await;
            }
        });
        log::debug!("Agent Run accepted session={id} input={input_id} run={run_id}");
        Ok(StartRunResponse { run: Some(run) })
    }
}

fn event(payload: agent_event::Payload) -> AgentEvent {
    AgentEvent {
        emitted_at_ms: now_ms().unwrap_or_default(),
        payload: Some(payload),
    }
}

fn display_item(item_id: String, block: &ContentBlock) -> Option<AgentItem> {
    let content = match block {
        ContentBlock::Text { text, .. } => agent_item::Content::AgentMessage(AgentMessage { text: text.clone() }),
        ContentBlock::Thinking { text, .. } => agent_item::Content::Reasoning(AgentReasoning { text: text.clone() }),
        _ => return None,
    };
    Some(AgentItem {
        item_id,
        content: Some(content),
    })
}

fn project_update(
    session_id: SessionId,
    run: &mut AgentRun,
    update: GenerationEvent,
    blocks: &mut BTreeMap<u32, (String, ContentBlock)>,
) -> Vec<agent_event::Payload> {
    let (index, delta, thinking, replacement) = match update {
        GenerationEvent::TextDelta { content_index, text } => (content_index, Some(text), false, None),
        GenerationEvent::ThinkingDelta { content_index, text } => (content_index, Some(text), true, None),
        GenerationEvent::BlockStarted { content_index, block }
        | GenerationEvent::BlockFinished { content_index, block } => (
            content_index,
            None,
            matches!(block, ContentBlock::Thinking { .. }),
            Some(block),
        ),
        _ => return Vec::new(),
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
    let session_id = session_id.to_string();
    if new && let Some(item) = display_item(item_id.clone(), block) {
        events.push(agent_event::Payload::ItemStarted(ItemStarted {
            session_id: session_id.clone(),
            run_id: run.run_id.clone(),
            item: Some(item),
        }));
    }
    if let Some(replacement) = replacement {
        *block = replacement;
    }
    if let Some(delta) = delta {
        match block {
            ContentBlock::Text { text, .. } | ContentBlock::Thinking { text, .. } => text.push_str(&delta),
            _ => return events,
        }
        if thinking {
            events.push(agent_event::Payload::ReasoningDelta(ReasoningDelta {
                session_id,
                run_id: run.run_id.clone(),
                item_id: item_id.clone(),
                delta,
            }));
        } else {
            events.push(agent_event::Payload::AgentMessageDelta(AgentMessageDelta {
                session_id,
                run_id: run.run_id.clone(),
                item_id: item_id.clone(),
                delta,
            }));
        }
    } else if let Some(item) = display_item(item_id.clone(), block) {
        events.push(agent_event::Payload::ItemCompleted(ItemCompleted {
            session_id,
            run_id: run.run_id.clone(),
            item: Some(item),
        }));
    }
    run.items.truncate(1);
    run.items.extend(
        blocks
            .values()
            .filter_map(|(id, block)| display_item(id.clone(), block)),
    );
    events
}
