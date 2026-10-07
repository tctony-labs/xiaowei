use std::collections::{BTreeMap, BTreeSet};

use xw_agent_rollout::{Journal, Result};
use xw_agent_types::*;

#[derive(Debug, Clone, Default)]
pub struct RecoveryState {
    pub pending_inputs: Vec<InputId>,
    pub runs: Vec<RunId>,
    pub turns: Vec<TurnId>,
    pub gens: Vec<GenId>,
    pub tools: Vec<ToolId>,
    pub interactions: Vec<InteractionId>,
}

pub fn inspect_recovery(entries: &[JournalEntry]) -> std::result::Result<RecoveryState, ValidationError> {
    validate_history(entries)?;
    let mut inputs = BTreeSet::new();
    let mut runs = BTreeSet::new();
    let mut turns = BTreeSet::new();
    let mut gens = BTreeSet::new();
    let mut tools = BTreeSet::new();
    let mut interactions = BTreeSet::new();
    for entry in entries {
        match &entry.payload {
            EntryPayload::InputAccepted(input) => {
                inputs.insert(input.input_id);
            }
            EntryPayload::InputConsumed(input) => {
                for id in &input.input_ids {
                    inputs.remove(id);
                }
            }
            EntryPayload::InputCancelled(input) => {
                inputs.remove(&input.input_id);
            }
            EntryPayload::RunStarted(run) => {
                runs.insert(run.run_id);
            }
            EntryPayload::RunEnd(run) => {
                runs.remove(&run.run_id);
            }
            EntryPayload::TurnStarted(turn) => {
                turns.insert(turn.turn_id);
            }
            EntryPayload::TurnEnded(turn) => {
                turns.remove(&turn.turn_id);
            }
            EntryPayload::GenStarted(generation) => {
                gens.insert(generation.gen_id);
            }
            EntryPayload::GenEnded(generation) => {
                gens.remove(&generation.gen_id);
            }
            EntryPayload::ToolIntent(tool) => {
                tools.insert(tool.tool_id);
            }
            EntryPayload::ToolOutcome(tool) => {
                tools.remove(&tool.tool_id);
            }
            EntryPayload::InteractionOpened(opened) => {
                interactions.insert(opened.interaction_id);
            }
            EntryPayload::InteractionResolved(resolved) => {
                interactions.remove(&resolved.interaction_id);
            }
            EntryPayload::InteractionExpired(expired) => {
                interactions.remove(&expired.interaction_id);
            }
            _ => {}
        }
    }
    Ok(RecoveryState {
        pending_inputs: inputs.into_iter().collect(),
        runs: runs.into_iter().collect(),
        turns: turns.into_iter().collect(),
        gens: gens.into_iter().collect(),
        tools: tools.into_iter().collect(),
        interactions: interactions.into_iter().collect(),
    })
}

/// Settle basic interrupted lifecycles, without executing models/tools or inventing results.
/// Unknown tools remain unknown; Continue policy is a later runtime responsibility.
pub fn settle_interrupted(
    journal: &mut Journal,
    known_failed_run: Option<RunId>,
    recovered_at_ms: i64,
) -> Result<RecoveryState> {
    let state = inspect_recovery(journal.entries()).map_err(|_| xw_agent_rollout::RolloutError::InvalidHistory)?;
    let entries = journal.entries().to_vec();
    let gens: BTreeMap<_, _> = entries
        .iter()
        .filter_map(|entry| match &entry.payload {
            EntryPayload::GenStarted(generation) => Some((generation.gen_id, generation)),
            _ => None,
        })
        .collect();
    for id in &state.interactions {
        let revision = entries
            .iter()
            .find_map(|entry| match &entry.payload {
                EntryPayload::InteractionOpened(opened) if opened.interaction_id == *id => Some(opened.revision),
                _ => None,
            })
            .expect("validated");
        journal.append(
            EntryPayload::InteractionExpired(InteractionExpired {
                interaction_id: *id,
                revision: revision + 1,
                reason: InteractionExpireReason::Recovery,
                preempting_input_id: None,
            }),
            recovered_at_ms,
        )?;
    }
    for id in &state.gens {
        let failed = gens[id].run_id.is_some() && gens[id].run_id == known_failed_run;
        let message = entries.iter().find_map(|entry| match &entry.payload {
            EntryPayload::Message(message) if message.gen_id == Some(*id) => Some(message),
            _ => None,
        });
        journal.append(
            EntryPayload::GenEnded(GenEnded {
                gen_id: *id,
                status: GenStatus::Interrupted,
                preempting_input_id: None,
                ended_at_ms: None,
                stop_reason: None,
                assistant_message_id: message.map(|message| message.message_id),
                usage: message.and_then(|message| match &message.message {
                    AgentMessage::Assistant(assistant) => assistant.usage.clone(),
                    _ => None,
                }),
                context_tokens: None,
                duration_ms: None,
                reasoning_duration_ms: None,
                error: failed.then(|| SafeError {
                    code: "rollout_write_failed".into(),
                    message: "会话记录写入失败".into(),
                }),
            }),
            recovered_at_ms,
        )?;
    }
    for id in &state.turns {
        let final_gen_id = journal.entries().iter().rev().find_map(|entry| match &entry.payload {
            EntryPayload::GenStarted(generation) if generation.turn_id == Some(*id) => Some(generation.gen_id),
            _ => None,
        });
        // Interrupted permits unresolved tool results, unlike a normal failed terminal.
        journal.append(
            EntryPayload::TurnEnded(TurnEnded {
                turn_id: *id,
                status: TurnStatus::Interrupted,
                final_gen_id,
                preempting_input_id: None,
                duration_ms: None,
                error: None,
            }),
            recovered_at_ms,
        )?;
    }
    for id in &state.runs {
        let tools_used = entries
            .iter()
            .filter(|entry| {
                matches!(&entry.payload,
            EntryPayload::ToolIntent(tool) if tool.key.run_id == *id)
            })
            .count() as u32;
        let had_assistant_output = entries.iter().any(|entry| {
            matches!(&entry.payload,
            EntryPayload::Message(message) if message.run_id == Some(*id))
        });
        let failed = known_failed_run == Some(*id);
        journal.append(
            EntryPayload::RunEnd(RunEnd {
                run_id: *id,
                status: if failed {
                    RunStatus::Failed
                } else {
                    RunStatus::Interrupted
                },
                error: failed.then(|| SafeError {
                    code: "rollout_write_failed".into(),
                    message: "会话记录写入失败".into(),
                }),
                duration_ms: None,
                had_assistant_output,
                tool_calls_used: tools_used,
                context_tokens: None,
            }),
            recovered_at_ms,
        )?;
    }
    inspect_recovery(journal.entries()).map_err(|_| xw_agent_rollout::RolloutError::InvalidHistory)
}
