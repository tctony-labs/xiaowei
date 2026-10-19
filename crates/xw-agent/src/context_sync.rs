use xw_agent_rollout::{Journal, RolloutError, WriterState};
use xw_agent_types::{
    ContextBoundary, EntryPayload, JournalEntry, SystemContext, SystemContextDelta,
    SystemContextUpdate, ValidationError,
};

/// Compares named content, without changing the caller's committed state.
pub fn plan_system_context_update(
    previous: Option<&SystemContext>,
    desired: &SystemContext,
) -> Result<Option<SystemContextUpdate>, ValidationError> {
    desired.validate()?;
    let Some(previous) = previous else {
        return Ok(Some(SystemContextUpdate::Baseline(desired.clone())));
    };
    previous.validate()?;

    if previous.has_same_content(desired) {
        return Ok(None);
    }

    let instructions = desired
        .instructions
        .iter()
        .filter(|(name, content)| previous.instructions.get(*name) != Some(*content))
        .map(|(name, content)| (name.clone(), content.clone()))
        .collect();
    let instructions_removed = previous
        .instructions
        .keys()
        .filter(|name| !desired.instructions.contains_key(*name))
        .cloned()
        .collect();
    let mut tools_added: Vec<_> = desired
        .tools
        .iter()
        .filter(|tool| {
            !previous
                .tools
                .iter()
                .any(|old| old.has_same_definition(tool))
        })
        .cloned()
        .collect();
    let mut tools_removed: Vec<_> = previous
        .tools
        .iter()
        .filter(|tool| {
            !desired
                .tools
                .iter()
                .any(|new| new.has_same_definition(tool))
        })
        .map(|tool| tool.name.clone())
        .collect();

    tools_added.sort_by(|left, right| left.name.cmp(&right.name));
    tools_removed.sort();

    Ok(Some(SystemContextUpdate::Delta(SystemContextDelta {
        instructions,
        instructions_removed,
        tools_added,
        tools_removed,
    })))
}

/// Uses durable history as the authority. A failed append never advances the synchronized state.
/// The caller owns failure recovery and must not generate until a required update has committed.
pub fn sync_system_context(
    journal: &mut Journal,
    desired: &SystemContext,
    timestamp_ms: i64,
) -> Result<Option<JournalEntry>, RolloutError> {
    if journal.state() == WriterState::NeedsCheck {
        return Err(RolloutError::NeedsCheck);
    }

    let boundary = ContextBoundary {
        through_entry_id: journal.entries().last().map(|entry| entry.entry_id),
        after_turn_id: None,
    };
    let rebuilt = crate::rebuild_context(journal.entries(), &boundary)?;
    let Some(update) = plan_system_context_update(rebuilt.system_context.as_ref(), desired)? else {
        return Ok(None);
    };

    let session_id = journal.entries()[0].session_id;
    let kind = match &update {
        SystemContextUpdate::Baseline(_) => "baseline",
        SystemContextUpdate::Delta(_) => "delta",
    };
    let entry = journal
        .append(EntryPayload::SystemContext(update), timestamp_ms)
        .inspect_err(|error| {
            log::error!("Agent system context commit failed session={session_id}: {error}");
        })?;
    log::debug!(
        "Agent system context committed session={session_id} entry={} kind={kind} tools={}",
        entry.entry_id,
        desired.tools.len(),
    );
    Ok(Some(entry))
}
