use xw_agent::{inspect_recovery, rebuild_context, settle_interrupted};
use xw_agent_rollout::RolloutStore;
use xw_agent_types::*;

fn fixture(name: &str) -> Vec<JournalEntry> {
    let text = match name {
        "text" => include_str!("fixtures/text.jsonl"),
        "tools" => include_str!("fixtures/tools.jsonl"),
        "interactions" => include_str!("fixtures/interactions.jsonl"),
        "compaction" => include_str!("fixtures/compaction.jsonl"),
        "continue" => include_str!("fixtures/continue.jsonl"),
        "interrupted" => include_str!("fixtures/interrupted.jsonl"),
        "inputs" => include_str!("fixtures/inputs.jsonl"),
        _ => unreachable!(),
    };
    decode_history(text).unwrap()
}

#[test]
fn every_committed_prefix_can_be_inspected_and_basic_lifecycles_settle_idempotently() {
    for name in [
        "text",
        "tools",
        "interactions",
        "compaction",
        "continue",
        "interrupted",
        "inputs",
    ] {
        let entries = fixture(name);
        for count in 2..=entries.len() {
            let directory = tempfile::tempdir().unwrap();
            let store = RolloutStore::new(directory.path());
            let EntryPayload::Meta(meta) = &entries[1].payload else {
                panic!()
            };
            let mut journal = store
                .create(entries[0].session_id, entries[0].timestamp_ms, meta.clone())
                .unwrap();
            for entry in &entries[2..count] {
                journal.append_entry(entry.clone()).unwrap();
            }
            inspect_recovery(journal.entries()).unwrap();
            let result = settle_interrupted(&mut journal, None, 2000)
                .unwrap_or_else(|error| panic!("fixture {name} prefix {count}: {error}"));
            assert!(result.runs.is_empty());
            assert!(result.turns.is_empty());
            assert!(result.gens.is_empty());
            let before = journal.entries().to_vec();
            settle_interrupted(&mut journal, None, 3000).unwrap();
            assert_eq!(journal.entries(), before);
        }
    }
}

#[test]
fn consumed_inputs_and_successful_generation_only_enter_context_and_checkpoints_respect_the_upper_bound() {
    for name in ["text", "tools", "compaction", "continue", "interrupted", "inputs"] {
        let entries = fixture(name);
        for upper in 2..=entries.len() {
            let boundary = ContextBoundary {
                through_entry_id: Some(entries[upper - 1].entry_id),
                after_turn_id: None,
            };
            let from_full = rebuild_context(&entries, &boundary).unwrap();
            let from_prefix = rebuild_context(&entries[..upper], &boundary).unwrap();
            assert_eq!(from_full.messages, from_prefix.messages);
            assert_eq!(from_full.budget, from_prefix.budget);
            let completed = entries[..upper]
                .iter()
                .filter(|entry| {
                    matches!(
                        &entry.payload,
                        EntryPayload::GenEnded(GenEnded {
                            status: GenStatus::Completed,
                            ..
                        })
                    )
                })
                .count();
            if completed == 0 {
                assert!(
                    !from_full
                        .messages
                        .iter()
                        .any(|message| matches!(message, AgentMessage::Assistant(_)))
                );
            }
        }
    }
    let entries = fixture("text");
    let sse_index = entries
        .iter()
        .position(|entry| matches!(entry.payload, EntryPayload::GenFirstSseReceived(_)))
        .unwrap();
    let state = inspect_recovery(&entries[..=sse_index]).unwrap();
    assert_eq!(state.gens.len(), 1);
    let built = rebuild_context(
        &entries[..=sse_index],
        &ContextBoundary {
            through_entry_id: Some(entries[sse_index].entry_id),
            after_turn_id: None,
        },
    )
    .unwrap();
    assert!(
        built
            .messages
            .iter()
            .all(|message| matches!(message, AgentMessage::User(_)))
    );
}
