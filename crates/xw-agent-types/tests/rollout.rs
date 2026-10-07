use xw_agent_types::*;

const FIXTURES: [&str; 7] = [
    include_str!("fixtures/v2/text.jsonl"),
    include_str!("fixtures/v2/tools.jsonl"),
    include_str!("fixtures/v2/interactions.jsonl"),
    include_str!("fixtures/v2/compaction.jsonl"),
    include_str!("fixtures/v2/continue.jsonl"),
    include_str!("fixtures/v2/interrupted.jsonl"),
    include_str!("fixtures/v2/inputs.jsonl"),
];

fn history(fixture: &str) -> Vec<JournalEntry> {
    decode_history(fixture).unwrap()
}

#[test]
fn all_fixed_histories_and_every_durable_prefix_are_valid() {
    for (index, fixture) in FIXTURES.iter().enumerate() {
        let entries = history(fixture);
        for upper in 0..=entries.len() {
            validate_history(&entries[..upper])
                .unwrap_or_else(|error| panic!("fixture {index}, prefix {upper}: {error:?}"));
        }
        for (index, (original, entry)) in fixture.lines().zip(&entries).enumerate() {
            let encoded = encode_entry(entry, &entries[..index]).unwrap();
            assert_eq!(decode_entry(&encoded, &entries[..index]).unwrap(), *entry);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&encoded).unwrap(),
                serde_json::from_str::<serde_json::Value>(original).unwrap()
            );
        }
    }
}

#[test]
fn stable_ids_validate_uuid_version_variant_and_canonical_spelling() {
    let id = SessionId::new();
    assert_eq!(id.to_string().parse::<SessionId>().unwrap(), id);
    for invalid in [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-7000-0000-000000000001",
        "00000000-0000-7000-8000-00000000000A",
        "secret-invalid-id",
    ] {
        let error = invalid.parse::<SessionId>().unwrap_err();
        assert_eq!(error, IdError);
        assert!(!error.to_string().contains(invalid));
    }
}

#[test]
fn generation_budget_ignores_auxiliary_calls_and_titles_do_not_replace_measurement() {
    let entries = history(FIXTURES[0]);
    let conversation_end = entries
        .iter()
        .filter_map(|entry| match &entry.payload {
            EntryPayload::GenEnded(end) => Some((entry, end)),
            _ => None,
        })
        .nth(1)
        .unwrap();
    let budget = ContextBudgetSnapshot::from_entries(&entries).unwrap();
    assert_eq!(budget.latest_gen_end_id, Some(conversation_end.0.entry_id));
    assert_eq!(budget.context_tokens, Some(125));
    assert!(!budget.stale);

    let mut history = history(FIXTURES[0]);
    for entry in &mut history {
        if let EntryPayload::RunStarted(run) = &mut entry.payload {
            run.context.limits.max_gens = Some(2);
        }
    }
    validate_history(&history).unwrap();
    if let EntryPayload::RunStarted(run) = &mut history[3].payload {
        run.context.limits.max_gens = Some(1);
    }
    assert!(validate_history(&history).is_err());
}

#[test]
fn checkpoints_keep_the_last_conversation_measurement_but_make_it_stale() {
    let entries = history(FIXTURES[3]);
    let budget = ContextBudgetSnapshot::from_entries(&entries).unwrap();
    assert_eq!(budget.context_tokens, Some(125));
    assert!(budget.stale);
    assert_eq!(budget.latest_compaction_id, Some(entries.last().unwrap().entry_id));
}
