use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use xw_agent_runtime::{
    RunRequest, RunStatus, compact,
    context_budget::{
        ContextBudget, ContextSample, SUMMARY_MAX_TOKENS, context_tokens, estimate_text,
        estimate_tokens,
    },
    execute_text,
};
use xw_agent_types as domain;

use crate::{
    AgentError, AgentService, CancellationToken, GenerationError, GenerationEvent,
    GenerationRequest, LlmGeneration,
    execution::{event, generation_update},
    protocol::AgentGeneration,
    service::{State, now_ms},
    session::Session,
};

pub(crate) const INPUT_LIMIT: &str = "当前上下文超过模型输入上限";
const SUMMARY_INPUT_LIMIT: &str = "当前上下文超过摘要请求的输入上限";
const SUMMARY_FAILED: &str = "自动压缩未生成可用摘要";
const REPLACEMENT_LIMIT: &str = "压缩后上下文仍超过模型输入上限";
const CHECKPOINT_FAILED: &str = "压缩检查点保存失败，已保留原上下文";

pub(crate) fn public_error(message: &str) -> Option<domain::SafeError> {
    matches!(
        message,
        INPUT_LIMIT | SUMMARY_INPUT_LIMIT | SUMMARY_FAILED | REPLACEMENT_LIMIT | CHECKPOINT_FAILED
    )
    .then(|| domain::SafeError {
        code: "context_compaction_failed".into(),
        message: message.into(),
    })
}

pub(crate) fn needs_preflight(session: &Session, budget: &ContextBudget) -> bool {
    budget.projected > budget.hard_limit || (budget.should_compact() && has_history(session))
}

fn has_history(session: &Session) -> bool {
    let first_new = session.summary_index.map_or(0, |index| index + 1);
    session.history[first_new..]
        .iter()
        .any(|message| !matches!(message, domain::AgentMessage::SystemContext { .. }))
}

pub(crate) async fn compact_if_needed(
    shared: &Mutex<State>,
    request: &RunRequest,
    model: &domain::ModelDescriptor,
    initial_input: &[domain::AgentMessage],
    sample: &mut Option<ContextSample>,
    previous_turn: Option<domain::TurnId>,
    generation: Arc<dyn LlmGeneration>,
    cancellation: &CancellationToken,
) -> Result<Result<(), &'static str>, AgentError> {
    let (at, messages, baseline, boundary, references, budget) = {
        let state = shared.lock().unwrap();
        let session = &state.sessions[&request.session_id];
        let upcoming = upcoming_input(session, request, initial_input, previous_turn);
        let budget = ContextBudget::new(&model.budget, *sample, &session.history, upcoming);
        if !needs_preflight(session, &budget) || cancellation.is_cancelled() {
            return Ok(Ok(()));
        }
        if !has_history(session) || crate::tool_registry::has_unclosed_calls(&session.history) {
            return Ok(Err(INPUT_LIMIT));
        }
        let boundary = session.boundary(previous_turn);
        let references = session
            .journal
            .as_ref()
            .map(|journal| {
                let rebuilt = crate::rebuild_context(journal.entries(), &boundary)
                    .map_err(|_| AgentError::Persistence)?;
                Ok::<_, AgentError>((
                    rebuilt.last_model_entry_id.ok_or(AgentError::Persistence)?,
                    rebuilt.budget.latest_compaction_id,
                ))
            })
            .transpose()?;
        let at = now_ms()?;
        (
            at,
            compact::summary_input(&session.history, at),
            crate::tool_registry::context(session)?,
            boundary,
            references,
            budget,
        )
    };

    let system_prompt = baseline
        .instructions
        .values()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n\n");
    let max_tokens = model
        .budget
        .max_output_tokens
        .min(u64::from(SUMMARY_MAX_TOKENS)) as u32;
    let estimated_input = estimate_tokens(&messages) + estimate_text(&system_prompt);
    if estimated_input > budget.window.saturating_sub(u64::from(max_tokens)) {
        log::warn!(
            "Agent compaction input too large session={} run={} estimated={} window={}",
            request.session_id,
            request.run_id,
            estimated_input,
            budget.window,
        );
        return Ok(Err(SUMMARY_INPUT_LIMIT));
    }
    let summary = RunRequest {
        session_id: request.session_id,
        input_id: request.input_id,
        run_id: request.run_id,
        turn_id: None,
        gen_id: domain::GenId::new(),
        message_id: domain::MessageId::new(),
        generation: GenerationRequest {
            session_id: request.session_id,
            isolate_provider_session: true,
            model_ref: request.generation.model_ref.clone(),
            system_prompt,
            messages: vec![],
            reasoning: request.generation.reasoning.clone(),
            temperature: request.generation.temperature,
            max_tokens: Some(max_tokens),
        },
    };
    let gen_started = domain::GenStarted {
        gen_id: summary.gen_id,
        run_id: Some(request.run_id),
        turn_id: None,
        purpose: domain::GenPurpose::Compaction,
        attempt: 1,
        started_at_ms: at,
        boundary: boundary.clone(),
        context: Some(domain::RunContext {
            permission_mode: None,
            model: model.clone(),
            generation: domain::GenerationParameters {
                reasoning: summary.generation.reasoning.clone(),
                temperature: summary.generation.temperature,
                max_tokens: Some(max_tokens),
                ..Default::default()
            },
            tools: vec![],
            limits: domain::RuntimeLimits {
                max_gens: Some(1),
                max_tool_calls: 0,
            },
        }),
    };
    {
        let mut state = shared.lock().unwrap();
        if cancellation.is_cancelled() {
            return Ok(Ok(()));
        }
        let session = state.sessions.get_mut(&request.session_id).unwrap();
        session.append(domain::EntryPayload::GenStarted(gen_started), at)?;
        let run = session.view.runs.last_mut().unwrap();
        run.generation = Some(AgentGeneration {
            gen_id: summary.gen_id.to_string(),
            started_at_ms: at,
            is_compaction: true,
            ..Default::default()
        });
        let update = generation_update(request.session_id, run);
        AgentService::publish(&mut state, event(update));
    }

    let (sender, mut receiver) = mpsc::channel(32);
    let mut execution = summary.clone();
    execution.generation.messages = messages;
    let future = execute_text(execution, generation, cancellation.child_token(), sender);
    tokio::pin!(future);
    // Retain the first SSE even if the summary is interrupted before it completes.
    let mut first_sse_committed = false;
    let mut outcome = loop {
        tokio::select! {
            biased;
            Some(update) = receiver.recv() => {
                if let GenerationEvent::FirstSseReceived { received_at_ms } = update.event {
                    let mut state = shared.lock().unwrap();
                    let session = state.sessions.get_mut(&request.session_id).unwrap();
                    record_first_sse(session, summary.gen_id, received_at_ms)?;
                    first_sse_committed = true;
                }
            }
            outcome = &mut future => break outcome,
        }
    };

    let mut state = shared.lock().unwrap();
    let session = state.sessions.get_mut(&request.session_id).unwrap();
    if !first_sse_committed && let Some(received_at_ms) = outcome.first_sse_at_ms {
        record_first_sse(session, summary.gen_id, received_at_ms)?;
    }
    let summary_text = outcome.message.as_ref().and_then(compact::summary_text);
    if cancellation.is_cancelled() {
        outcome.status = RunStatus::Cancelled;
    } else if summary_text.is_none() && outcome.status == RunStatus::Completed {
        outcome.status = RunStatus::Failed;
        outcome.error = Some(GenerationError::Failed(SUMMARY_FAILED.into()));
    }
    session.record_generation(&summary, &outcome, &Default::default())?;

    let result = if cancellation.is_cancelled() {
        Ok(())
    } else if let Some(text) = summary_text.filter(|_| outcome.status == RunStatus::Completed) {
        let upcoming = upcoming_input(session, request, initial_input, previous_turn);
        let upcoming_tokens = estimate_tokens(upcoming);
        let mut messages = vec![domain::AgentMessage::SystemContext {
            update: domain::SystemContextUpdate::Baseline(baseline.clone()),
        }];
        let retain = budget
            .hard_limit
            .saturating_sub(upcoming_tokens)
            .saturating_sub(estimate_tokens(&messages))
            .saturating_sub(estimate_text(&text))
            .min(budget.window / 5);
        let replacement = compact::replacement_history(
            &session.history,
            &text,
            outcome.ended_at_ms,
            session.summary_index,
            retain,
        );
        messages.extend(replacement.iter().cloned());
        let after = estimate_tokens(&messages) + upcoming_tokens;
        if after > budget.hard_limit {
            return end_generation(&mut state, request, Err(REPLACEMENT_LIMIT));
        }
        if let Some((replaced_through_entry_id, previous_checkpoint_id)) = references {
            let trigger = if previous_turn.is_some() {
                domain::CompactionTrigger::AutoBetweenTurns
            } else {
                domain::CompactionTrigger::AutoPreRun
            };
            let checkpoint = domain::EntryPayload::Compacted(domain::Compacted {
                gen_id: summary.gen_id,
                run_id: Some(request.run_id),
                boundary,
                replaced_through_entry_id,
                kept_from_entry_id: None,
                previous_checkpoint_id,
                summary: text,
                replacement_history: replacement,
                system_context: Some(baseline),
                trigger,
                tokens_before: budget.measured,
                estimated_tokens_before: Some(budget.estimated),
                context_window: budget.window,
                duration_ms: Some(outcome.elapsed_ms),
            });
            if session.append(checkpoint, now_ms()?).is_err() {
                // A complete JSONL line can exist even when its sync fails.
                session
                    .journal
                    .as_mut()
                    .expect("durable checkpoint")
                    .check_after_failure()
                    .map_err(crate::persistence::storage_error)?;
                return end_generation(&mut state, request, Err(CHECKPOINT_FAILED));
            }
        }
        session.summary_index = Some(messages.len() - 1);
        session.history = messages;
        *sample = None;
        log::debug!(
            "Agent context compacted session={} gen={} projected={} estimated_after={after}",
            request.session_id,
            summary.gen_id,
            budget.projected,
        );
        Ok(())
    } else {
        Err(SUMMARY_FAILED)
    };
    end_generation(&mut state, request, result)
}

fn record_first_sse(
    session: &mut Session,
    gen_id: domain::GenId,
    at: i64,
) -> Result<(), AgentError> {
    session.append(
        domain::EntryPayload::GenFirstSseReceived(domain::GenFirstSseReceived {
            gen_id,
            received_at_ms: at,
        }),
        at,
    )?;
    Ok(())
}

fn upcoming_input<'a>(
    session: &'a Session,
    request: &RunRequest,
    initial_input: &'a [domain::AgentMessage],
    previous_turn: Option<domain::TurnId>,
) -> &'a [domain::AgentMessage] {
    if previous_turn.is_some() {
        crate::queue::steering_input(session, request.run_id)
            .map_or(&[], |input| std::slice::from_ref(&input.message.message))
    } else {
        initial_input
    }
}

fn end_generation(
    state: &mut State,
    request: &RunRequest,
    result: Result<(), &'static str>,
) -> Result<Result<(), &'static str>, AgentError> {
    if let Err(error) = result {
        log::warn!(
            "Agent compaction failed session={} run={}: {error}",
            request.session_id,
            request.run_id
        );
    }
    let run = state
        .sessions
        .get_mut(&request.session_id)
        .unwrap()
        .view
        .runs
        .last_mut()
        .unwrap();
    run.generation = None;
    let update = generation_update(request.session_id, run);
    AgentService::publish(state, event(update));
    Ok(result)
}

/// Reuse only a completed conversation request from the same model since the latest checkpoint.
pub(crate) fn previous_sample(session: &Session, model_ref: &str) -> Option<ContextSample> {
    let (offset, assistant) =
        session
            .history
            .iter()
            .enumerate()
            .rev()
            .find_map(|(offset, message)| match message {
                domain::AgentMessage::Assistant(assistant) => Some((offset, assistant)),
                _ => None,
            })?;
    let tokens = if let Some(journal) = &session.journal {
        let entries = journal.entries();
        let after_checkpoint = entries
            .iter()
            .rposition(|entry| matches!(entry.payload, domain::EntryPayload::Compacted(_)))
            .map_or(0, |index| index + 1);
        // The latest successful conversation completion supplies the last model
        // assistant message after the checkpoint. Archived bodies may be released.
        let recent = &entries[after_checkpoint..];
        let (recorded, sample) = recent.iter().rev().find_map(|entry| {
            let domain::EntryPayload::GenEnded(end) = &entry.payload else {
                return None;
            };
            if end.status != domain::GenStatus::Completed {
                return None;
            }
            recent
                .iter()
                .rev()
                .find_map(|candidate| match &candidate.payload {
                    domain::EntryPayload::Message(message)
                        if end.assistant_message_id == Some(message.message_id)
                            && message.turn_id.is_some() =>
                    {
                        Some((message, end))
                    }
                    _ => None,
                })
        })?;
        let same_model = entries.iter().rev().any(|entry| {
            matches!(&entry.payload, domain::EntryPayload::RunStarted(start)
                if Some(start.run_id) == recorded.run_id
                    && start.context.model.model_ref == model_ref)
        });
        if !same_model {
            return None;
        }
        sample
            .context_tokens
            .or_else(|| assistant.usage.as_ref().and_then(context_tokens))?
    } else {
        let run = session.view.runs.last()?;
        let config = run.config.as_ref()?;
        if run.status != crate::protocol::AgentRunStatus::Completed as i32
            || config.model_ref != model_ref
        {
            return None;
        }
        assistant.usage.as_ref().and_then(context_tokens)?
    };
    Some(ContextSample { tokens, offset })
}

#[cfg(test)]
mod tests;
