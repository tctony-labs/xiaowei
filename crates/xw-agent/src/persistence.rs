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
                let session = restore(journal)?;
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

pub(crate) fn initial_meta(session: &Session) -> domain::SessionMeta {
    let config = session.view.config.as_ref().expect("validated config");
    domain::SessionMeta {
        model_ref: Some(config.model_ref.clone()),
        reasoning: config.reasoning.clone(),
        provider_name: (!session.view.provider_name.is_empty()).then(|| session.view.provider_name.clone()),
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
        crate::settle_interrupted(journal, self.failed_run, now_ms()?).map_err(storage_error)?;
        self.failed_run = None;
        // Rebuild accepted identities too: a failed start may have committed InputAccepted
        // without making it into the live projection. Such an input must never be accepted twice.
        let restored = project(self.journal.as_ref().expect("journal exists"))?;
        self.history = restored.history;
        self.requests = restored.requests;
        for run in restored.view.runs {
            if !self.view.runs.iter().any(|current| current.run_id == run.run_id) {
                self.view.runs.push(run);
            }
        }
        Ok(())
    }
}

pub(crate) fn restore(journal: Journal) -> Result<Session, AgentError> {
    let mut session = project(&journal)?;
    session.journal = Some(journal);
    Ok(session)
}

fn project(journal: &Journal) -> Result<Session, AgentError> {
    let entries = journal.entries();
    let boundary = domain::ContextBoundary {
        through_entry_id: entries.last().map(|entry| entry.entry_id),
        after_turn_id: None,
    };
    let rebuilt = crate::rebuild_context(entries, &boundary).map_err(|_| AgentError::Persistence)?;
    let id = entries[0].session_id;
    let config = AgentModelConfig {
        model_ref: rebuilt.meta.model_ref.clone().ok_or(AgentError::Persistence)?,
        reasoning: rebuilt.meta.reasoning.clone(),
    };
    let mut session = Session::new(id, entries[0].timestamp_ms, config);
    session.view.provider_name = rebuilt.meta.provider_name.clone().unwrap_or_default();
    session.view.model_name = rebuilt.meta.model_name.clone().unwrap_or_default();
    let mut accepted = std::collections::BTreeMap::new();
    for entry in entries {
        match &entry.payload {
            domain::EntryPayload::InputAccepted(input) => {
                accepted.insert(input.input_id, input);
            }
            domain::EntryPayload::RunStarted(run) => {
                let domain::RunCause::Send { input_id } = run.cause else {
                    continue;
                };
                let input = accepted[&input_id];
                let content = match &input.message.message {
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
                        item_id: input.message.block_ids[0].to_string(),
                        content: Some(agent_item::Content::UserMessage(AgentUserMessage { content })),
                    }],
                    ..Default::default()
                });
            }
            domain::EntryPayload::Message(message) if message.run_id.is_some() => {
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
                                agent_item::Content::AgentMessage(AgentMessage { text: text.clone() })
                            }
                            domain::ContentBlock::Thinking { text, .. } => {
                                agent_item::Content::Reasoning(AgentReasoning { text: text.clone() })
                            }
                            _ => continue,
                        };
                        run.items.push(AgentItem {
                            item_id: id.to_string(),
                            content: Some(content),
                        });
                    }
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
    session.history = rebuilt.messages;
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
    ) -> Result<(), AgentError> {
        if self.journal.is_none() {
            return Ok(());
        }
        self.prepare_writer()?;
        let started_at = now_ms()?;
        let boundary = domain::ContextBoundary {
            through_entry_id: self
                .journal
                .as_ref()
                .and_then(|journal| journal.entries().last())
                .map(|entry| entry.entry_id),
            after_turn_id: None,
        };
        let context = domain::RunContext {
            model,
            generation: domain::GenerationParameters {
                reasoning: execution.generation.reasoning.clone(),
                temperature: execution.generation.temperature,
                max_tokens: execution.generation.max_tokens,
                ..Default::default()
            },
            tools: Vec::new(),
            limits: domain::RuntimeLimits {
                max_gens: Some(1),
                max_tool_calls: 0,
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
        self.append(
            domain::EntryPayload::InputAccepted(domain::InputAccepted {
                input_id: execution.input_id,
                source,
                mode: domain::InputMode::Send,
                expected_run_id: None,
                expected_head: None,
                selection: request.config.as_ref().map(|config| domain::ModelSelection {
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
        self.append(
            domain::EntryPayload::RunStarted(domain::RunStarted {
                run_id: execution.run_id,
                cause: domain::RunCause::Send {
                    input_id: execution.input_id,
                },
                base_context: boundary.clone(),
                context,
            }),
            started_at,
        )?;
        self.append(
            domain::EntryPayload::TurnStarted(domain::TurnStarted {
                turn_id: execution.turn_id,
                run_id: execution.run_id,
                ordinal: 1,
                boundary: boundary.clone(),
            }),
            started_at,
        )?;
        let consumed = self
            .append(
                domain::EntryPayload::InputConsumed(domain::InputConsumed {
                    input_ids: vec![execution.input_id],
                    run_id: execution.run_id,
                    turn_id: execution.turn_id,
                    boundary,
                }),
                started_at,
            )?
            .expect("journal exists");
        self.append(
            domain::EntryPayload::GenStarted(domain::GenStarted {
                gen_id: execution.gen_id,
                run_id: Some(execution.run_id),
                turn_id: Some(execution.turn_id),
                attempt: 1,
                purpose: domain::GenPurpose::Conversation,
                context: None,
                boundary: domain::ContextBoundary {
                    through_entry_id: Some(consumed.entry_id),
                    after_turn_id: None,
                },
                started_at_ms: started_at,
            }),
            started_at,
        )?;
        Ok(())
    }

    pub(crate) fn record_end(
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
        let context_tokens = usage.as_ref().map(|usage| usage.input);
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
                    turn_id: Some(execution.turn_id),
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
        let (gen_status, turn_status, run_status) = match outcome.status {
            xw_agent_runtime::RunStatus::Completed => (
                domain::GenStatus::Completed,
                domain::TurnStatus::Completed,
                domain::RunStatus::Completed,
            ),
            xw_agent_runtime::RunStatus::Failed => (
                domain::GenStatus::Failed,
                domain::TurnStatus::Failed,
                domain::RunStatus::Failed,
            ),
            xw_agent_runtime::RunStatus::Cancelled => (
                domain::GenStatus::Aborted,
                domain::TurnStatus::Aborted,
                domain::RunStatus::Aborted,
            ),
        };
        self.append(
            domain::EntryPayload::GenEnded(domain::GenEnded {
                gen_id: execution.gen_id,
                status: gen_status,
                preempting_input_id: None,
                ended_at_ms: Some(outcome.ended_at_ms),
                stop_reason,
                assistant_message_id: recorded_id,
                usage,
                context_tokens,
                duration_ms: Some(outcome.elapsed_ms),
                reasoning_duration_ms: None,
                error: error.clone(),
            }),
            outcome.ended_at_ms,
        )?;
        self.append(
            domain::EntryPayload::TurnEnded(domain::TurnEnded {
                turn_id: execution.turn_id,
                status: turn_status,
                final_gen_id: Some(execution.gen_id),
                preempting_input_id: None,
                duration_ms: Some(outcome.elapsed_ms),
                error: error.clone(),
            }),
            outcome.ended_at_ms,
        )?;
        self.append(
            domain::EntryPayload::RunEnd(domain::RunEnd {
                run_id: execution.run_id,
                status: run_status,
                error,
                duration_ms: Some(outcome.elapsed_ms),
                had_assistant_output: recorded_id.is_some(),
                tool_calls_used: 0,
                context_tokens,
            }),
            outcome.ended_at_ms,
        )?;
        Ok(())
    }
}
