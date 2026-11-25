use std::collections::{HashMap, HashSet};

use prost::Message;
use xw_agent_rollout::{Journal, RolloutError};
use xw_agent_runtime::RunRequest;
use xw_agent_types as domain;

use crate::{
    AgentError, AgentService, GenerationRequest, InputSource,
    execution::{MAX_DISPLAY_BYTES, MAX_HISTORY_BYTES, event, model_descriptor},
    persistence::storage_error,
    protocol::*,
    service::now_ms,
    session::{Session, parse_id},
};

impl AgentService {
    pub async fn continue_run(
        &self,
        request: ContinueRunRequest,
        source: InputSource,
    ) -> Result<ContinueRunResponse, AgentError> {
        let id = parse_id(&request.session_id, "session_id")?;
        let previous = parse_id(&request.previous_run_id, "previous_run_id")?;
        let client_request_id = parse_id(&request.client_request_id, "client_request_id")?;
        if source.principal_id.trim().is_empty() || source.principal_id.len() > 1024 {
            return Err(AgentError::InvalidArgument("source.principal_id"));
        }
        let cause = domain::RunCause::Continue {
            previous_run_id: previous,
            client_request_id,
            source,
        };
        let _gate = if let Some(index) = &self.index {
            let gate = index.gate.lock().await;
            self.require(&request.session_id).await?;
            Some(gate)
        } else {
            None
        };
        let (config, cwd, cache) = {
            let mut state = self.state()?;
            let session = state
                .sessions
                .get_mut(&id)
                .filter(|s| !s.deleted())
                .ok_or(AgentError::NotFound("session"))?;
            session.available()?;
            session.prepare_writer()?;
            if let Some(run) = previous_request(session, &cause)? {
                return Ok(ContinueRunResponse { run: Some(run) });
            }
            let last = target(session, previous)?;
            (
                last.config.clone().ok_or(AgentError::Persistence)?,
                session.view.cwd.clone(),
                session.resource_cache.clone(),
            )
        };
        let (skills, resources) = self.snapshot_resources(cwd, cache).await?;
        let info = self
            .host
            .get_model_info(config.model_ref.clone())
            .await
            .and_then(|info| crate::model::validate_info(&config.model_ref, info))
            .ok();
        let model = model_descriptor(&config.model_ref, info);

        let mut state = self.state()?;
        let session = state
            .sessions
            .get_mut(&id)
            .filter(|s| !s.deleted())
            .ok_or(AgentError::NotFound("session"))?;
        session.available()?;
        session.prepare_writer()?;
        if let Some(run) = previous_request(session, &cause)? {
            return Ok(ContinueRunResponse { run: Some(run) });
        }
        target(session, previous)?;
        let handle =
            tokio::runtime::Handle::try_current().map_err(|_| AgentError::ExecutionUnavailable)?;
        let entries = session.journal.as_ref().expect("durable session").entries();
        let (input_id, pending) = original_inputs(entries, previous)?;
        crate::tool_registry::prepare(session)?;
        crate::skills::prepare(session, skills)?;
        crate::resources::prepare(session, resources)?;

        let at = now_ms()?;
        let run_id = domain::RunId::new();
        let started = domain::RunStarted {
            run_id,
            cause,
            base_context: session.boundary(None),
            context: domain::RunContext {
                permission_mode: None,
                model: model.clone(),
                generation: domain::GenerationParameters {
                    reasoning: config.reasoning.clone(),
                    ..Default::default()
                },
                tools: crate::tool_registry::context(session)?.tools,
                limits: domain::RuntimeLimits {
                    max_gens: Some(51),
                    max_tool_calls: 50,
                },
            },
        };
        let run = continued_run(&started, previous, at);
        if session.view.encoded_len() + run.encoded_len() > MAX_DISPLAY_BYTES - 2048 {
            return Err(AgentError::ResourceExhausted("display history"));
        }
        let mut items = match begin(session, started, previous, at) {
            Ok(items) => items,
            Err(error) => {
                session.failed_run = Some(run_id);
                return Err(error);
            }
        };
        let sample = crate::compaction::previous_sample(session, &model.model_ref);
        let queue_changed = pending.iter().any(|(id, _)| {
            session
                .queue
                .iter()
                .any(|entry| entry.accepted.input_id == *id)
        });
        for item in &mut items {
            let old = session.view.runs.last_mut().expect("previous Run");
            if let Some(existing) = old
                .items
                .iter_mut()
                .find(|other| other.item_id == item.item_id)
            {
                if let (
                    Some(agent_item::Content::ToolCall(prior)),
                    Some(agent_item::Content::ToolCall(recovered)),
                ) = (&existing.content, &mut item.content)
                {
                    recovered.interaction = prior.interaction.clone();
                }
                *existing = item.clone();
            } else {
                old.items.push(item.clone());
            }
        }
        for item in items {
            AgentService::publish(
                &mut state,
                event(agent_event::Payload::ItemCompleted(ItemCompleted {
                    session_id: id.to_string(),
                    run_id: previous.to_string(),
                    item: Some(item),
                })),
            );
        }
        let execution = RunRequest {
            session_id: id,
            input_id,
            run_id,
            turn_id: Some(domain::TurnId::new()),
            gen_id: domain::GenId::new(),
            message_id: domain::MessageId::new(),
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
        self.launch_run(
            &mut state,
            run.clone(),
            crate::run_loop::RunPlan {
                request: execution,
                model,
                sample,
                pending_first: Some(pending),
            },
            queue_changed,
            handle,
        );
        log::debug!("Agent Continue accepted session={id} previous_run={previous} run={run_id}");
        Ok(ContinueRunResponse { run: Some(run) })
    }
}

pub(crate) fn continued_run(
    start: &domain::RunStarted,
    previous: domain::RunId,
    at: i64,
) -> AgentRun {
    let model = &start.context.model;
    AgentRun {
        run_id: start.run_id.to_string(),
        continued_from_run_id: Some(previous.to_string()),
        status: AgentRunStatus::InProgress.into(),
        config: Some(AgentModelConfig {
            model_ref: model.model_ref.clone(),
            reasoning: start.context.generation.reasoning.clone(),
        }),
        provider_name: model.provider_name.clone().unwrap_or_default(),
        model_name: model.model_name.clone().unwrap_or_default(),
        started_at_ms: at,
        ..Default::default()
    }
}

fn target(session: &Session, previous: domain::RunId) -> Result<&AgentRun, AgentError> {
    if session.active.is_some() || session.dispatching.is_some() {
        return Err(AgentError::Conflict("session is running"));
    }
    let latest = session.view.runs.last().ok_or_else(|| {
        if session.run_count() == 0 {
            AgentError::NotFound("run")
        } else {
            AgentError::Conflict("only the latest unsuccessful run can continue")
        }
    })?;
    if latest.run_id != previous.to_string() || latest.status == AgentRunStatus::Completed as i32 {
        return Err(AgentError::Conflict(
            "only the latest unsuccessful run can continue",
        ));
    }
    Ok(latest)
}

fn previous_request(
    session: &Session,
    cause: &domain::RunCause,
) -> Result<Option<AgentRun>, AgentError> {
    let entries = session
        .journal
        .as_ref()
        .ok_or(AgentError::Conflict("Continue requires session history"))?
        .entries();
    let domain::RunCause::Continue {
        client_request_id,
        source,
        ..
    } = cause
    else {
        unreachable!("Continue cause");
    };
    let Some(run) = entries.iter().find_map(|entry| match &entry.payload {
        domain::EntryPayload::RunStarted(run)
            if matches!(&run.cause, domain::RunCause::Continue {
                client_request_id: id, source: caller, ..
            } if id == client_request_id && caller.principal_id == source.principal_id) =>
        {
            Some(run)
        }
        _ => None,
    }) else {
        return Ok(None);
    };
    if &run.cause != cause {
        return Err(AgentError::Conflict("continue identity"));
    }
    session.run_page(&run.run_id.to_string()).map(Some)
}

fn begin(
    session: &mut Session,
    started: domain::RunStarted,
    previous: domain::RunId,
    at: i64,
) -> Result<Vec<AgentItem>, AgentError> {
    let run_id = started.run_id;
    session
        .journal
        .as_mut()
        .expect("durable session")
        .restore_completed_contents()
        .map_err(storage_error)?;
    session.append(domain::EntryPayload::RunStarted(started), at)?;

    let journal = session.journal.as_mut().expect("durable session");
    let items = settle_calls(journal, previous, run_id, at).map_err(storage_error)?;
    crate::tool_registry::synchronize(session, at)?;
    let rebuilt = crate::rebuild_context(
        session.journal.as_ref().expect("durable session").entries(),
        &session.boundary(None),
    )
    .map_err(|error| {
        log::error!("Agent Continue context rebuild failed run={run_id}: {error}");
        AgentError::Persistence
    })?;
    session.history = rebuilt.messages;
    session.summary_index = rebuilt.summary_index;
    let bytes = serde_json::to_vec(&session.history)
        .map_err(|_| AgentError::Internal)?
        .len()
        + session
            .requests
            .values()
            .map(Message::encoded_len)
            .sum::<usize>();
    if bytes > MAX_HISTORY_BYTES {
        return Err(AgentError::ResourceExhausted(
            "model history and input identities",
        ));
    }
    Ok(items)
}

type PendingInputs = Vec<(domain::InputId, domain::AgentMessage)>;

fn original_inputs(
    entries: &[domain::JournalEntry],
    mut run_id: domain::RunId,
) -> Result<(domain::InputId, PendingInputs), AgentError> {
    use domain::{EntryPayload::*, RunCause};
    let ids = loop {
        let cause = entries
            .iter()
            .rev()
            .find_map(|entry| match &entry.payload {
                RunStarted(run) if run.run_id == run_id => Some(&run.cause),
                _ => None,
            })
            .ok_or(AgentError::Persistence)?;
        match cause {
            RunCause::Continue {
                previous_run_id, ..
            } => run_id = *previous_run_id,
            RunCause::Send { input_id }
            | RunCause::Queued { input_id }
            | RunCause::Interrupt { input_id, .. } => break std::slice::from_ref(input_id),
            RunCause::FollowUp { input_ids } => break input_ids.as_slice(),
        }
    };
    let mut pending = Vec::new();
    for id in ids {
        for entry in entries.iter().rev() {
            match &entry.payload {
                InputConsumed(input) if input.input_ids.contains(id) => break,
                InputCancelled(input) if input.input_id == *id => {
                    return Err(AgentError::Conflict("the original input was cancelled"));
                }
                InputAccepted(input) if input.input_id == *id => {
                    pending.push((*id, input.message.message.clone()));
                    break;
                }
                InputEdited(input) if input.input_id == *id => {
                    pending.push((*id, input.message.message.clone()));
                    break;
                }
                _ => {}
            }
        }
    }
    Ok((ids[0], pending))
}

pub(crate) fn settle_calls(
    journal: &mut Journal,
    previous: domain::RunId,
    continuing: domain::RunId,
    at: i64,
) -> Result<Vec<AgentItem>, RolloutError> {
    use domain::EntryPayload::*;
    let entries = journal.entries();
    let completed = entries
        .iter()
        .filter_map(|entry| match &entry.payload {
            GenEnded(end) if end.status == domain::GenStatus::Completed => end.assistant_message_id,
            _ => None,
        })
        .collect::<HashSet<_>>();
    let previous_end = entries
        .iter()
        .find_map(|entry| match &entry.payload {
            RunEnd(end) if end.run_id == previous => Some(entry.sequence),
            _ => None,
        })
        .ok_or(RolloutError::InvalidHistory)?;
    let intents = entries
        .iter()
        .filter_map(|entry| match &entry.payload {
            ToolIntent(intent) if intent.key.run_id == previous => {
                Some((intent.block_id, (intent, entry.sequence < previous_end)))
            }
            _ => None,
        })
        .collect::<HashMap<_, _>>();
    let outcomes = entries
        .iter()
        .filter_map(|entry| match &entry.payload {
            ToolOutcome(outcome) if outcome.key.run_id == previous => Some(outcome.tool_id),
            _ => None,
        })
        .collect::<HashSet<_>>();
    let mut pending = Vec::new();
    for entry in entries {
        let Message(message) = &entry.payload else {
            continue;
        };
        if message.run_id != Some(previous)
            || message.turn_id.is_none()
            || !completed.contains(&message.message_id)
        {
            continue;
        }
        let domain::AgentMessage::Assistant(assistant) = &message.message else {
            continue;
        };
        for (block_id, block) in message.block_ids.iter().zip(&assistant.content) {
            let domain::ContentBlock::ToolCall {
                id,
                name,
                arguments_json: Some(arguments),
                ..
            } = block
            else {
                continue;
            };
            let prior = intents.get(block_id);
            if prior.is_some_and(|(intent, _)| outcomes.contains(&intent.tool_id)) {
                continue;
            }
            let intent = if let Some((intent, _)) = prior {
                (*intent).clone()
            } else {
                domain::ToolIntent {
                    tool_id: domain::ToolId::new(),
                    key: domain::ProviderToolKey {
                        run_id: previous,
                        turn_id: message.turn_id.ok_or(RolloutError::InvalidHistory)?,
                        gen_id: message.gen_id.ok_or(RolloutError::InvalidHistory)?,
                        provider_call_id: id.clone(),
                    },
                    assistant_message_id: message.message_id,
                    block_id: *block_id,
                    tool_name: name.clone(),
                    arguments_json: arguments.clone(),
                    generation_duration_ms: None,
                }
            };
            pending.push((
                intent,
                prior.is_some(),
                prior.is_some_and(|(_, started)| *started),
            ));
        }
    }
    let mut items = Vec::new();
    for (intent, recorded, started) in pending {
        if !recorded {
            journal.append(ToolIntent(intent.clone()), at)?;
        }
        let (status, text) = if started {
            (
                domain::ToolStatus::ResultUnknown,
                "上次工具结果未知，未自动重试",
            )
        } else {
            (domain::ToolStatus::Skipped, "上次运行中断，此工具尚未执行")
        };
        let mut outcome =
            crate::run_loop::tool_outcome(&intent, status, text.into(), None, None, at);
        outcome.settled_by_run_id = Some(continuing);
        journal.append(ToolOutcome(outcome.clone()), at)?;
        items.push(crate::run_loop::tool_item(&intent, Some(&outcome)));
    }
    Ok(items)
}

pub(crate) fn repeat_guard(session: &Session, run_id: domain::RunId) -> Vec<domain::ToolIntent> {
    use domain::EntryPayload::*;
    let Some(journal) = &session.journal else {
        return Vec::new();
    };
    let mut ancestors = HashSet::new();
    let mut current = run_id;
    for entry in journal.entries().iter().rev() {
        if let RunStarted(run) = &entry.payload
            && run.run_id == current
            && let domain::RunCause::Continue {
                previous_run_id, ..
            } = run.cause
        {
            ancestors.insert(previous_run_id);
            current = previous_run_id;
        }
    }
    if ancestors.is_empty() {
        return Vec::new();
    }

    let prior_effects = journal
        .entries()
        .iter()
        .filter_map(|entry| match &entry.payload {
            ToolOutcome(outcome)
                if ancestors.contains(&outcome.key.run_id)
                    && outcome.status != domain::ToolStatus::Skipped =>
            {
                Some(outcome.tool_id)
            }
            _ => None,
        })
        .collect::<HashSet<_>>();
    journal
        .entries()
        .iter()
        .filter_map(|entry| match &entry.payload {
            ToolIntent(intent)
                if prior_effects.contains(&intent.tool_id)
                    && (matches!(
                        intent.tool_name.as_str(),
                        "Write" | "Edit" | "Bash" | "BgRun" | "BgStop"
                    ) || session.tools.iter().any(|tool| {
                        tool.declaration.name == intent.tool_name
                            && tool.recovery == crate::RecoveryPolicy::ResultUnknown
                    })) =>
            {
                Some(intent.clone())
            }
            _ => None,
        })
        .collect()
}
