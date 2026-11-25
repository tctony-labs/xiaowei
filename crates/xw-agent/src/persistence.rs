use std::{path::PathBuf, sync::Arc};

use xw_agent_rollout::{Journal, RolloutError, RolloutStore, WriterState};
use xw_agent_types as domain;

use crate::{AgentError, AgentHost, AgentService, protocol::*, service::now_ms, session::Session};

pub(crate) fn storage_error(error: RolloutError) -> AgentError {
    log::error!("Agent rollout failure: {error}");
    match error {
        RolloutError::Busy => AgentError::Conflict("session writer"),
        _ => AgentError::Persistence,
    }
}

impl AgentService {
    /// Blocking file initialization; embedding hosts must run this off their UI thread.
    pub fn with_rollout(host: Arc<dyn AgentHost>, root: PathBuf) -> Result<Self, AgentError> {
        let mut service = Self::new(host);
        let store = RolloutStore::new(root);
        {
            let mut state = service.state()?;
            for id in store.session_ids().map_err(storage_error)? {
                let (mut journal, repair) = store.open(id).map_err(storage_error)?;
                crate::settle_interrupted(&mut journal, None, now_ms()?).map_err(storage_error)?;
                let mut session = restore(journal)?;
                crate::tool_registry::bind(&mut session, &state.tools)?;
                if repair.discarded_bytes > 0 {
                    log::debug!(
                        "Agent rollout tail repaired session={id} bytes={}",
                        repair.discarded_bytes
                    );
                }
                state.sessions.insert(id, session);
            }
        }
        service.rollout = Some(store);
        Ok(service)
    }
}

pub(crate) fn run_input_item_id(
    session: &Session,
    input_id: domain::InputId,
    original: domain::BlockId,
    run_entry_id: Option<domain::EntryId>,
) -> String {
    if session.has_run_for_input(input_id) {
        // A retried queued input has a distinct timeline item for each attempt.
        run_entry_id.map_or_else(|| domain::BlockId::new().to_string(), |id| id.to_string())
    } else {
        original.to_string()
    }
}

pub(crate) fn initial_meta(session: &Session) -> domain::SessionMeta {
    let config = session.view.config.as_ref().expect("validated config");
    domain::SessionMeta {
        permission_mode: None,
        model_ref: Some(config.model_ref.clone()),
        reasoning: config.reasoning.clone(),
        provider_name: (!session.view.provider_name.is_empty())
            .then(|| session.view.provider_name.clone()),
        model_name: (!session.view.model_name.is_empty()).then(|| session.view.model_name.clone()),
    }
}

impl Session {
    pub(crate) fn append(
        &mut self,
        payload: domain::EntryPayload,
        timestamp: i64,
    ) -> Result<Option<domain::JournalEntry>, AgentError> {
        self.journal
            .as_mut()
            .map(|journal| journal.append(payload, timestamp))
            .transpose()
            .map_err(storage_error)
    }

    pub(crate) fn commit_meta(&mut self, view: &AgentSession) -> Result<(), AgentError> {
        let Some(mut meta) = self.meta.clone() else {
            return Ok(());
        };
        let config = view.config.as_ref().ok_or(AgentError::Internal)?;
        meta.model_ref = Some(config.model_ref.clone());
        meta.reasoning = config.reasoning.clone();
        meta.provider_name = (!view.provider_name.is_empty()).then(|| view.provider_name.clone());
        meta.model_name = (!view.model_name.is_empty()).then(|| view.model_name.clone());
        if self.meta.as_ref() == Some(&meta) {
            return Ok(());
        }
        if let Err(error) = self.append(domain::EntryPayload::Meta(meta.clone()), now_ms()?) {
            if let Some(active) = &self.active {
                active.cancellation.cancel();
                self.failed_run = Some(active.run_id);
            }
            return Err(error);
        }
        self.meta = Some(meta);
        Ok(())
    }

    pub(crate) fn prepare_writer(&mut self) -> Result<(), AgentError> {
        let Some(journal) = &mut self.journal else {
            return Ok(());
        };
        if journal.state() != WriterState::NeedsCheck && self.failed_run.is_none() {
            return Ok(());
        }
        if self.active.is_some() {
            return Err(AgentError::Conflict("failed run is settling"));
        }
        journal.check_after_failure().map_err(storage_error)?;
        journal
            .restore_completed_contents()
            .map_err(storage_error)?;
        crate::recovery::settle_with_tools(journal, self.failed_run, now_ms()?, &self.tools)
            .map_err(storage_error)?;
        self.failed_run = None;
        // Rebuild accepted identities too: a failed start may have committed InputAccepted
        // without making it into the live projection. Such an input must never be accepted twice.
        let restored = project(self.journal.as_ref().expect("journal exists"))?;
        self.history = restored.history;
        self.summary_index = restored.summary_index;
        self.requests = restored.requests;
        self.queue = restored.queue;
        self.view.queued_inputs = restored.view.queued_inputs;
        self.interactions = restored.interactions;
        self.granted_paths = restored.granted_paths;
        self.permission_mode = restored.permission_mode;
        self.meta = restored.meta;
        let mut current_runs = std::mem::take(&mut self.view.runs);
        self.display_history = None;
        for run in restored.view.runs {
            let Some(position) = current_runs
                .iter()
                .position(|current| current.run_id == run.run_id)
            else {
                self.view.runs.push(run);
                continue;
            };
            let mut current = current_runs.remove(position);
            for item in run
                .items
                .into_iter()
                .filter(|item| matches!(item.content, Some(agent_item::Content::ToolCall(_))))
            {
                if let Some(existing) = current
                    .items
                    .iter_mut()
                    .find(|existing| existing.item_id == item.item_id)
                {
                    *existing = item;
                } else {
                    current.items.push(item);
                }
            }
            self.view.runs.push(current);
        }
        for id in self.interactions.keys().copied().collect::<Vec<_>>() {
            crate::interactive::project(self, id);
        }
        self.archive_display()?;
        self.journal.as_mut().unwrap().release_completed_contents();
        Ok(())
    }
}

pub(crate) fn restore(journal: Journal) -> Result<Session, AgentError> {
    let mut session = project(&journal)?;
    session.journal = Some(journal);
    session.archive_display()?;
    session
        .journal
        .as_mut()
        .unwrap()
        .release_completed_contents();
    Ok(session)
}

fn project(journal: &Journal) -> Result<Session, AgentError> {
    let entries = journal.entries();
    let boundary = domain::ContextBoundary {
        through_entry_id: entries.last().map(|entry| entry.entry_id),
        after_turn_id: None,
    };
    let rebuilt =
        crate::rebuild_context(entries, &boundary).map_err(|_| AgentError::Persistence)?;
    let id = entries[0].session_id;
    let config = AgentModelConfig {
        model_ref: rebuilt
            .meta
            .model_ref
            .clone()
            .ok_or(AgentError::Persistence)?,
        reasoning: rebuilt.meta.reasoning.clone(),
    };
    let mut session = Session::new(id, entries[0].timestamp_ms, config);
    session.permission_mode = journal
        .permission_mode()
        .map_err(storage_error)?
        .unwrap_or_default();
    session.view.cwd = match &entries[0].payload {
        domain::EntryPayload::SessionHeader { cwd: Some(cwd) } => Some(cwd.clone()),
        _ => Some(crate::workspace::prepare(journal.root(), id)?),
    };
    session.view.provider_name = rebuilt.meta.provider_name.clone().unwrap_or_default();
    session.view.model_name = rebuilt.meta.model_name.clone().unwrap_or_default();
    let mut accepted = std::collections::BTreeMap::new();
    let mut input_messages = std::collections::BTreeMap::new();
    let mut generations = std::collections::BTreeMap::new();
    let mut first_turns = std::collections::BTreeSet::new();
    for entry in entries {
        match &entry.payload {
            domain::EntryPayload::InputAccepted(input) => {
                accepted.insert(input.input_id, input);
                input_messages.insert(input.input_id, &input.message);
                if input.mode != domain::InputMode::Send {
                    session.queue.push(crate::queue::PendingInput {
                        accepted: input.clone(),
                        message: input.message.clone(),
                        mode: input.mode,
                        target: input.expected_run_id,
                    });
                }
            }
            domain::EntryPayload::InputEdited(input) => {
                input_messages.insert(input.input_id, &input.message);
                if let Some(queued) = session
                    .queue
                    .iter_mut()
                    .find(|entry| entry.accepted.input_id == input.input_id)
                {
                    queued.message = input.message.clone();
                }
            }
            domain::EntryPayload::InputRouted(input) => {
                if let Some(queued) = session
                    .queue
                    .iter_mut()
                    .find(|entry| entry.accepted.input_id == input.input_id)
                {
                    queued.mode = input.mode;
                    queued.target = input.expected_run_id;
                }
            }
            domain::EntryPayload::InputCancelled(input) => {
                session
                    .queue
                    .retain(|entry| entry.accepted.input_id != input.input_id);
            }
            domain::EntryPayload::TurnStarted(turn) if turn.ordinal == 1 => {
                first_turns.insert(turn.turn_id);
            }
            domain::EntryPayload::InputConsumed(input) => {
                session
                    .queue
                    .retain(|entry| !input.input_ids.contains(&entry.accepted.input_id));
                if let Some(run) = session
                    .view
                    .runs
                    .iter_mut()
                    .find(|run| run.run_id == input.run_id.to_string())
                {
                    if run.continued_from_run_id.is_some() && first_turns.contains(&input.turn_id) {
                        continue;
                    }
                    for id in &input.input_ids {
                        let message = input_messages[id];
                        let input_id = id.to_string();
                        if run.items.iter().any(|item| {
                            matches!(&item.content,
                                Some(agent_item::Content::UserMessage(user))
                                    if user.input_id.as_deref() == Some(&input_id)
                            )
                        }) {
                            continue;
                        }
                        let domain::AgentMessage::User(user) = &message.message else {
                            return Err(AgentError::Persistence);
                        };
                        run.items.push(AgentItem {
                            item_id: message.block_ids[0].to_string(),
                            gen_id: None,
                            content: Some(agent_item::Content::UserMessage(AgentUserMessage {
                                input_id: Some(input_id),
                                content: user
                                    .content
                                    .iter()
                                    .filter_map(|block| match block {
                                        domain::ContentBlock::Text { text, .. } => {
                                            Some(AgentUserInput {
                                                content: Some(agent_user_input::Content::Text(
                                                    text.clone(),
                                                )),
                                            })
                                        }
                                        _ => None,
                                    })
                                    .collect(),
                            })),
                            ..Default::default()
                        });
                    }
                }
            }
            domain::EntryPayload::RunStarted(run) => {
                let input_id = match &run.cause {
                    domain::RunCause::Send { input_id }
                    | domain::RunCause::Interrupt { input_id, .. }
                    | domain::RunCause::Queued { input_id } => *input_id,
                    domain::RunCause::FollowUp { input_ids } => input_ids[0],
                    domain::RunCause::Continue {
                        previous_run_id, ..
                    } => {
                        session.view.runs.push(crate::continuation::continued_run(
                            run,
                            *previous_run_id,
                            entry.timestamp_ms,
                        ));
                        continue;
                    }
                };
                let message = input_messages[&input_id];
                let content = match &message.message {
                    domain::AgentMessage::User(user) => user
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            domain::ContentBlock::Text { text, .. } => Some(AgentUserInput {
                                content: Some(agent_user_input::Content::Text(text.clone())),
                            }),
                            _ => None,
                        })
                        .collect(),
                    _ => return Err(AgentError::Persistence),
                };
                let item_id = run_input_item_id(
                    &session,
                    input_id,
                    message.block_ids[0],
                    Some(entry.entry_id),
                );
                let model = &run.context.model;
                let reasoning = run.context.generation.reasoning.clone();
                session.view.runs.push(AgentRun {
                    run_id: run.run_id.to_string(),
                    input_id: input_id.to_string(),
                    config: Some(AgentModelConfig {
                        model_ref: model.model_ref.clone(),
                        reasoning,
                    }),
                    provider_name: model.provider_name.clone().unwrap_or_default(),
                    model_name: model.model_name.clone().unwrap_or_default(),
                    started_at_ms: entry.timestamp_ms,
                    items: vec![AgentItem {
                        item_id,
                        gen_id: None,
                        content: Some(agent_item::Content::UserMessage(AgentUserMessage {
                            content,
                            input_id: Some(input_id.to_string()),
                        })),
                        ..Default::default()
                    }],
                    ..Default::default()
                });
            }
            domain::EntryPayload::GenStarted(generation) => {
                if generation.purpose == domain::GenPurpose::Conversation
                    && let Some(run_id) = generation.run_id
                {
                    generations.insert(generation.gen_id, run_id);
                }
            }
            domain::EntryPayload::GenEnded(generation) => {
                if generation.status == domain::GenStatus::Completed
                    && matches!(
                        generation.stop_reason,
                        Some(domain::FinishReason::Stop | domain::FinishReason::Length)
                    )
                    && let Some(run_id) = generations.get(&generation.gen_id)
                    && let Some(run) = session
                        .view
                        .runs
                        .iter_mut()
                        .find(|run| run.run_id == run_id.to_string())
                {
                    run.final_gen_id = Some(generation.gen_id.to_string());
                }
            }
            domain::EntryPayload::Message(message)
                if message
                    .gen_id
                    .is_some_and(|id| generations.contains_key(&id)) =>
            {
                if let Some(run) = session
                    .view
                    .runs
                    .iter_mut()
                    .find(|run| run.run_id == message.run_id.unwrap().to_string())
                    && let domain::AgentMessage::Assistant(assistant) = &message.message
                {
                    for (id, block) in message.block_ids.iter().zip(&assistant.content) {
                        let content = match block {
                            domain::ContentBlock::Text { text, .. } => {
                                agent_item::Content::AgentMessage(AgentMessage {
                                    text: text.clone(),
                                })
                            }
                            domain::ContentBlock::Thinking { text, .. } => {
                                agent_item::Content::Reasoning(AgentReasoning {
                                    text: text.clone(),
                                })
                            }
                            _ => continue,
                        };
                        run.items.push(AgentItem {
                            item_id: id.to_string(),
                            gen_id: message.gen_id.map(|id| id.to_string()),
                            content: Some(content),
                            ..Default::default()
                        });
                    }
                }
            }
            domain::EntryPayload::ToolIntent(intent) => {
                if let Some(run) = session
                    .view
                    .runs
                    .iter_mut()
                    .find(|run| run.run_id == intent.key.run_id.to_string())
                {
                    run.items.push(crate::run_loop::tool_item(intent, None));
                }
            }
            domain::EntryPayload::ToolOutcome(outcome) => {
                if let Some(intent) = entries.iter().find_map(|entry| match &entry.payload {
                    domain::EntryPayload::ToolIntent(intent)
                        if intent.tool_id == outcome.tool_id =>
                    {
                        Some(intent)
                    }
                    _ => None,
                }) && let Some(run) = session
                    .view
                    .runs
                    .iter_mut()
                    .find(|run| run.run_id == intent.key.run_id.to_string())
                    && let Some(item) = run
                        .items
                        .iter_mut()
                        .find(|item| item.item_id == intent.block_id.to_string())
                {
                    *item = crate::run_loop::tool_item(intent, Some(outcome));
                }
            }
            domain::EntryPayload::RunEnd(end) => {
                if let Some(run) = session
                    .view
                    .runs
                    .iter_mut()
                    .find(|run| run.run_id == end.run_id.to_string())
                {
                    run.status = match end.status {
                        domain::RunStatus::Completed => AgentRunStatus::Completed,
                        domain::RunStatus::Failed => AgentRunStatus::Failed,
                        _ => AgentRunStatus::Interrupted,
                    }
                    .into();
                    run.completed_at_ms = Some(entry.timestamp_ms);
                    run.error = end.error.as_ref().map(|error| error.message.clone());
                    if end.status != domain::RunStatus::Completed {
                        run.final_gen_id = None;
                    }
                    for item in &mut run.items {
                        if let Some(agent_item::Content::ToolCall(tool)) = &mut item.content
                            && tool.status == AgentToolStatus::Pending as i32
                        {
                            tool.status = AgentToolStatus::ResultUnknown.into();
                        }
                    }
                }
            }
            domain::EntryPayload::InteractionOpened(opened) => {
                session.interactions.insert(
                    opened.interaction_id,
                    crate::interactive::InteractionRecord::new(opened.clone()),
                );
            }
            domain::EntryPayload::InteractionResolved(resolved) => {
                if let Some(record) = session.interactions.get_mut(&resolved.interaction_id) {
                    record.resolved = Some(resolved.clone());
                }
            }
            domain::EntryPayload::InteractionExpired(expired) => {
                if let Some(record) = session.interactions.get_mut(&expired.interaction_id) {
                    record.expired = Some(expired.clone());
                }
            }
            _ => {}
        }
    }
    // Every committed acceptance reserves its input ID, including a start interrupted
    // before RunStarted. Recovery never automatically runs such an input.
    for (input_id, input) in accepted {
        let domain::AgentMessage::User(user) = &input.message.message else {
            return Err(AgentError::Persistence);
        };
        let content = user
            .content
            .iter()
            .filter_map(|block| match block {
                domain::ContentBlock::Text { text, .. } => Some(AgentUserInput {
                    content: Some(agent_user_input::Content::Text(text.clone())),
                }),
                _ => None,
            })
            .collect();
        session.requests.insert(
            input_id,
            StartRunRequest {
                session_id: id.to_string(),
                input_id: input_id.to_string(),
                input: content,
                config: input.selection.as_ref().map(|selection| AgentModelConfig {
                    model_ref: selection.model_ref.clone(),
                    reasoning: selection.reasoning.clone(),
                }),
                ..Default::default()
            },
        );
    }
    for id in session.interactions.keys().copied().collect::<Vec<_>>() {
        crate::interactive::project(&mut session, id);
    }
    session.granted_paths = rebuilt.granted_paths;
    session.history = rebuilt.messages;
    session.summary_index = rebuilt.summary_index;
    session.view.queued_inputs = session
        .queue
        .iter()
        .map(crate::queue::PendingInput::view)
        .collect();
    session.meta = Some(rebuilt.meta);
    Ok(session)
}

impl Session {
    pub(crate) fn record_start(
        &mut self,
        request: &StartRunRequest,
        source: domain::InputSource,
        execution: &xw_agent_runtime::RunRequest,
        user_item_id: domain::BlockId,
        model: domain::ModelDescriptor,
        tools: Vec<domain::ToolDeclaration>,
        queued: Option<&crate::queue::PendingInput>,
        manual: bool,
    ) -> Result<Option<domain::EntryId>, AgentError> {
        if self.journal.is_none() {
            return Ok(None);
        }
        self.prepare_writer()?;
        let started_at = now_ms()?;
        let boundary = self.boundary(None);
        let context = domain::RunContext {
            permission_mode: None,
            model,
            generation: domain::GenerationParameters {
                reasoning: execution.generation.reasoning.clone(),
                temperature: execution.generation.temperature,
                max_tokens: execution.generation.max_tokens,
                ..Default::default()
            },
            tools,
            limits: domain::RuntimeLimits {
                max_gens: Some(51),
                max_tool_calls: 50,
            },
        };
        let content = request
            .input
            .iter()
            .map(|input| match &input.content {
                Some(agent_user_input::Content::Text(text)) => domain::ContentBlock::Text {
                    text: text.clone(),
                    signature: None,
                },
                _ => unreachable!("validated input"),
            })
            .collect::<Vec<_>>();
        let mut block_ids = vec![user_item_id];
        block_ids.extend((1..content.len()).map(|_| domain::BlockId::new()));
        if queued.is_none() {
            self.append(
                domain::EntryPayload::InputAccepted(domain::InputAccepted {
                    input_id: execution.input_id,
                    source,
                    mode: domain::InputMode::Send,
                    expected_run_id: None,
                    expected_head: None,
                    selection: request
                        .config
                        .as_ref()
                        .map(|config| domain::ModelSelection {
                            model_ref: config.model_ref.clone(),
                            reasoning: config.reasoning.clone(),
                        }),
                    message: domain::RecordedMessage {
                        message_id: domain::MessageId::new(),
                        block_ids,
                        run_id: None,
                        turn_id: None,
                        gen_id: None,
                        input_id: Some(execution.input_id),
                        completeness: domain::MessageCompleteness::Complete,
                        message: domain::AgentMessage::User(domain::UserMessage {
                            content,
                            timestamp_ms: started_at,
                        }),
                    },
                }),
                started_at,
            )?;
        }
        let cause = match queued {
            Some(_) if manual => domain::RunCause::Queued {
                input_id: execution.input_id,
            },
            Some(input) if input.mode == domain::InputMode::Interrupt => {
                domain::RunCause::Interrupt {
                    input_id: execution.input_id,
                    previous_run_id: input.target.ok_or(AgentError::Internal)?,
                }
            }
            Some(_) => domain::RunCause::FollowUp {
                input_ids: vec![execution.input_id],
            },
            None => domain::RunCause::Send {
                input_id: execution.input_id,
            },
        };
        let started = self.append(
            domain::EntryPayload::RunStarted(domain::RunStarted {
                run_id: execution.run_id,
                cause,
                base_context: boundary,
                context,
            }),
            started_at,
        )?;
        Ok(started.map(|entry| entry.entry_id))
    }

    pub(crate) fn boundary(
        &self,
        after_turn_id: Option<domain::TurnId>,
    ) -> domain::ContextBoundary {
        domain::ContextBoundary {
            through_entry_id: self
                .journal
                .as_ref()
                .and_then(|journal| journal.entries().last())
                .map(|entry| entry.entry_id),
            after_turn_id: if self.journal.is_some() {
                after_turn_id
            } else {
                None
            },
        }
    }

    pub(crate) fn record_first_turn(
        &mut self,
        execution: &xw_agent_runtime::RunRequest,
        input_ids: &[domain::InputId],
        started_at: i64,
    ) -> Result<(), AgentError> {
        if self.journal.is_none() {
            return Ok(());
        }
        let boundary = self.boundary(None);
        self.append(
            domain::EntryPayload::TurnStarted(domain::TurnStarted {
                turn_id: execution.turn_id.expect("conversation Turn"),
                run_id: execution.run_id,
                ordinal: 1,
                boundary: boundary.clone(),
            }),
            started_at,
        )?;
        if !input_ids.is_empty() {
            self.append(
                domain::EntryPayload::InputConsumed(domain::InputConsumed {
                    input_ids: input_ids.to_vec(),
                    run_id: execution.run_id,
                    turn_id: execution.turn_id.expect("conversation Turn"),
                    boundary,
                }),
                started_at,
            )?;
        }
        self.append(
            domain::EntryPayload::GenStarted(domain::GenStarted {
                gen_id: execution.gen_id,
                run_id: Some(execution.run_id),
                turn_id: execution.turn_id,
                attempt: 1,
                purpose: domain::GenPurpose::Conversation,
                context: None,
                boundary: self.boundary(None),
                started_at_ms: started_at,
            }),
            started_at,
        )?;
        Ok(())
    }

    pub(crate) fn record_generation(
        &mut self,
        execution: &xw_agent_runtime::RunRequest,
        outcome: &xw_agent_runtime::RunOutcome,
        display_ids: &std::collections::BTreeMap<u32, (String, domain::ContentBlock)>,
    ) -> Result<(), AgentError> {
        if self.journal.is_none() {
            return Ok(());
        }
        let mut message = outcome.message.clone();
        if message.is_none() && !outcome.partial.is_empty() {
            message = Some(domain::AssistantMessage {
                content: outcome.partial.clone(),
                api: String::new(),
                provider: String::new(),
                model_id: String::new(),
                usage: None,
                stop_reason: if outcome.status == xw_agent_runtime::RunStatus::Cancelled {
                    domain::FinishReason::Aborted
                } else {
                    domain::FinishReason::Error
                },
                timestamp_ms: outcome.ended_at_ms,
                response_id: None,
                response_model: None,
                provider_thinking_level: None,
                raw_stop_reason: None,
                end_turn: None,
            });
        }
        let recorded_id = message.as_ref().map(|_| execution.message_id);
        let stop_reason = message.as_ref().map(|message| message.stop_reason);
        let usage = message.as_ref().and_then(|message| message.usage.clone());
        if let Some(message) = message {
            let block_ids = message
                .content
                .iter()
                .enumerate()
                .map(|(index, _)| {
                    display_ids
                        .get(&(index as u32))
                        .and_then(|(id, _)| id.parse().ok())
                        .unwrap_or_default()
                })
                .collect();
            self.append(
                domain::EntryPayload::Message(domain::RecordedMessage {
                    message_id: execution.message_id,
                    block_ids,
                    run_id: Some(execution.run_id),
                    turn_id: execution.turn_id,
                    gen_id: Some(execution.gen_id),
                    input_id: None,
                    completeness: if outcome.status == xw_agent_runtime::RunStatus::Completed {
                        domain::MessageCompleteness::Complete
                    } else {
                        domain::MessageCompleteness::Partial
                    },
                    message: domain::AgentMessage::Assistant(message),
                }),
                outcome.ended_at_ms,
            )?;
        }
        let error = outcome.error.as_ref().map(|_| domain::SafeError {
            code: "generation_failed".into(),
            message: "模型请求失败，请检查模型配置后重试".into(),
        });
        let gen_status = match outcome.status {
            xw_agent_runtime::RunStatus::Completed => domain::GenStatus::Completed,
            xw_agent_runtime::RunStatus::Failed => domain::GenStatus::Failed,
            xw_agent_runtime::RunStatus::Cancelled => domain::GenStatus::Aborted,
        };
        self.append(
            domain::EntryPayload::GenEnded(domain::GenEnded {
                gen_id: execution.gen_id,
                status: gen_status,
                ended_at_ms: Some(outcome.ended_at_ms),
                stop_reason,
                assistant_message_id: recorded_id,
                context_tokens: (execution.turn_id.is_some()
                    && outcome.status == xw_agent_runtime::RunStatus::Completed)
                    .then(|| {
                        usage
                            .as_ref()
                            .and_then(xw_agent_runtime::context_budget::context_tokens)
                    })
                    .flatten(),
                usage,
                duration_ms: Some(outcome.elapsed_ms),
                reasoning_duration_ms: None,
                error: error.clone(),
            }),
            outcome.ended_at_ms,
        )?;
        Ok(())
    }
}
