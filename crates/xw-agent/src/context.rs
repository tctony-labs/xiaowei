use std::collections::{BTreeMap, BTreeSet};

use xw_agent_types::*;

/// Rebuilt values only. Runtime handles, Host connections and tools stay in memory.
#[derive(Debug, Clone)]
pub struct RebuiltContext {
    pub meta: SessionMeta,
    pub messages: Vec<AgentMessage>,
    pub granted_paths: Vec<PermissionTarget>,
    pub budget: ContextBudgetSnapshot,
}

pub fn rebuild_context(
    entries: &[JournalEntry],
    boundary: &ContextBoundary,
) -> Result<RebuiltContext, ValidationError> {
    validate_history(entries)?;
    let upper = match boundary.through_entry_id {
        Some(id) => entries
            .iter()
            .position(|entry| entry.entry_id == id)
            .map(|index| index + 1)
            .ok_or_else(|| invalid("boundary.through_entry_id"))?,
        None => 0,
    };
    let entries = &entries[..upper];
    if let Some(turn_id) = boundary.after_turn_id
        && !entries
            .iter()
            .any(|entry| matches!(&entry.payload, EntryPayload::TurnEnded(end) if end.turn_id == turn_id))
    {
        return Err(invalid("boundary.after_turn_id"));
    }
    let meta = entries
        .iter()
        .rev()
        .find_map(|entry| match &entry.payload {
            EntryPayload::Meta(meta) => Some(meta.clone()),
            _ => None,
        })
        .ok_or_else(|| invalid("meta"))?;
    let mut inputs = BTreeMap::new();
    let mut messages = BTreeMap::new();
    let mut generations = BTreeMap::new();
    let mut positions = BTreeMap::new();
    let mut checkpoints = BTreeMap::new();
    let mut effective = Vec::<(EntryId, AgentMessage)>::new();
    let mut interactions = BTreeMap::new();
    let mut granted_paths = Vec::new();
    let mut granted = BTreeSet::new();
    for entry in entries {
        positions.insert(entry.entry_id, entry.sequence.0);
        match &entry.payload {
            EntryPayload::InputAccepted(input) => {
                inputs.insert(input.input_id, &input.message.message);
            }
            EntryPayload::InputConsumed(input) => {
                for id in &input.input_ids {
                    effective.push((entry.entry_id, inputs[id].clone()));
                }
            }
            EntryPayload::GenStarted(generation) => {
                generations.insert(generation.gen_id, generation.purpose.clone());
            }
            EntryPayload::Message(message) => {
                messages.insert(message.message_id, (entry.entry_id, &message.message));
            }
            EntryPayload::GenEnded(end)
                if end.status == GenStatus::Completed && generations[&end.gen_id] == GenPurpose::Conversation =>
            {
                let (id, message) = messages[&end.assistant_message_id.expect("validated")];
                effective.push((id, message.clone()));
            }
            EntryPayload::ToolOutcome(outcome) => {
                effective.push((entry.entry_id, outcome.result.message.clone()));
            }
            EntryPayload::Compacted(compacted) => {
                checkpoints.insert(entry.entry_id, compacted);
            }
            EntryPayload::InteractionOpened(opened) => {
                interactions.insert(opened.interaction_id, &opened.request);
            }
            EntryPayload::InteractionResolved(resolved) => {
                if let (InteractionRequest::Permission { target, .. }, InteractionAnswer::Permission { allow: true }) =
                    (interactions[&resolved.interaction_id], &resolved.answer)
                    && granted.insert((target.path.clone(), target.is_directory))
                {
                    granted_paths.push(target.clone());
                }
            }
            _ => {}
        }
    }
    let mut rebuilt = Vec::new();
    let mut replaced = 0;
    if let Some((id, checkpoint)) = checkpoints.iter().max_by_key(|(id, _)| positions[id]) {
        rebuilt.extend(checkpoint.replacement_history.iter().cloned());
        let mut through = checkpoint.replaced_through_entry_id;
        while let Some(previous) = checkpoints.get(&through) {
            through = previous.replaced_through_entry_id;
        }
        replaced = positions[&through];
        debug_assert!(positions[id] <= upper as u64);
    }
    rebuilt.extend(
        effective
            .into_iter()
            .filter(|(id, _)| positions[id] > replaced)
            .map(|(_, message)| message),
    );
    Ok(RebuiltContext {
        meta,
        messages: rebuilt,
        granted_paths,
        budget: ContextBudgetSnapshot::from_entries(entries)?,
    })
}

fn invalid(path: &str) -> ValidationError {
    ValidationError {
        code: ValidationCode::MissingReference,
        entry_id: None,
        message_index: None,
        path: path.into(),
    }
}
