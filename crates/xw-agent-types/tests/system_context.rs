use std::collections::BTreeMap;

use serde_json::json;
use xw_agent_types::*;

fn initial() -> SystemContext {
    SystemContext {
        instructions: BTreeMap::from([("behavior".into(), "Synthetic instruction.".into())]),
        tools: vec![ToolDeclaration {
            name: "Read".into(),
            description: "Synthetic tool.".into(),
            parameters_json: r#"{"type":"object","properties":{}}"#.into(),
            constrained_sampling_json: None,
        }],
    }
}

fn append(entries: &mut Vec<JournalEntry>, update: SystemContextUpdate) {
    entries.push(JournalEntry {
        schema_version: HISTORY_VERSION,
        session_id: entries[0].session_id,
        entry_id: EntryId::new(),
        sequence: Sequence(entries.len() as u64 + 1),
        timestamp_ms: 1000,
        payload: EntryPayload::SystemContext(update),
    });
}

#[test]
fn new_records_roundtrip_without_rewriting_existing_text_history() {
    let source = include_str!("fixtures/v2/text.jsonl");
    let mut entries = decode_history(source).unwrap();
    append(&mut entries, SystemContextUpdate::Baseline(initial()));
    append(
        &mut entries,
        SystemContextUpdate::Delta(SystemContextDelta {
            instructions: BTreeMap::from([("behavior".into(), "Updated behavior.".into())]),
            tools_removed: vec!["Read".into()],
            ..Default::default()
        }),
    );
    let encoded = encode_history(&entries).unwrap();
    assert!(encoded.starts_with(source));
    assert_eq!(decode_history(&encoded).unwrap(), entries);
    assert!(ContextBudgetSnapshot::from_entries(&entries).unwrap().stale);
}

#[test]
fn rejects_missing_baselines_duplicate_baselines_and_noop_deltas() {
    let original = decode_history(include_str!("fixtures/v2/text.jsonl")).unwrap();
    let mut entries = original.clone();
    append(
        &mut entries,
        SystemContextUpdate::Delta(SystemContextDelta {
            tools_removed: vec!["Read".into()],
            ..Default::default()
        }),
    );
    assert_eq!(
        validate_history(&entries).unwrap_err().code,
        ValidationCode::MissingReference
    );

    for delta in [
        SystemContextDelta::default(),
        SystemContextDelta {
            instructions: initial().instructions,
            ..Default::default()
        },
        SystemContextDelta {
            tools_added: initial().tools,
            tools_removed: vec!["Read".into()],
            ..Default::default()
        },
    ] {
        let mut entries = original.clone();
        append(&mut entries, SystemContextUpdate::Baseline(initial()));
        append(&mut entries, SystemContextUpdate::Delta(delta));
        assert!(validate_history(&entries).is_err());
    }

    let mut entries = original;
    append(
        &mut entries,
        SystemContextUpdate::Baseline(SystemContext::default()),
    );
    append(&mut entries, SystemContextUpdate::Baseline(initial()));
    assert!(validate_history(&entries).is_err());
}

#[test]
fn rejects_unknown_removals_duplicate_names_and_replacements_without_removal() {
    let baseline = initial();
    let tool = baseline.tools[0].clone();
    for delta in [
        SystemContextDelta {
            tools_removed: vec!["missing".into()],
            ..Default::default()
        },
        SystemContextDelta {
            instructions_removed: vec!["missing".into()],
            ..Default::default()
        },
        SystemContextDelta {
            tools_removed: vec!["Read".into(), "Read".into()],
            ..Default::default()
        },
        SystemContextDelta {
            tools_added: vec![tool.clone()],
            ..Default::default()
        },
        SystemContextDelta {
            tools_added: vec![tool.clone(), tool.clone()],
            ..Default::default()
        },
        SystemContextDelta {
            instructions: baseline.instructions.clone(),
            instructions_removed: vec!["behavior".into()],
            ..Default::default()
        },
    ] {
        assert!(
            SystemContextUpdate::Delta(delta)
                .apply(Some(&baseline))
                .is_err()
        );
    }
    let mut duplicate = baseline;
    duplicate.tools.push(tool);
    assert_eq!(
        duplicate.validate().unwrap_err().code,
        ValidationCode::DuplicateIdentity
    );
}

#[test]
fn diagnostics_do_not_include_instruction_names_content_or_schemas() {
    let mut baseline = initial();
    baseline.tools[0].parameters_json = "secret malformed schema".into();
    let error = baseline.validate().unwrap_err();
    assert!(!format!("{error:?} {error}").contains("secret"));

    baseline = initial();
    baseline.instructions = BTreeMap::from([("secret instruction".into(), " ".into())]);
    let error = baseline.validate().unwrap_err();
    assert!(!format!("{error:?} {error}").contains("secret"));
}

#[test]
fn stored_updates_reject_unknown_fields_duplicate_keys_and_positional_objects() {
    let mut entries = decode_history(include_str!("fixtures/v2/text.jsonl")).unwrap();
    let baseline = entries.clone();
    append(&mut entries, SystemContextUpdate::Baseline(initial()));
    let line = encode_entry(entries.last().unwrap(), &baseline).unwrap();
    let original: serde_json::Value = serde_json::from_str(&line).unwrap();
    for path in [
        "/payload/data",
        "/payload/data/data",
        "/payload/data/data/tools/0",
    ] {
        let mut invalid = original.clone();
        invalid
            .pointer_mut(path)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("secret-key".into(), json!("secret-value"));
        let error = decode_entry(&invalid.to_string(), &baseline).unwrap_err();
        assert!(!format!("{error:?} {error}").contains("secret"));

        let mut invalid = original.clone();
        let object = invalid.pointer_mut(path).unwrap();
        let values = object
            .as_object()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        *object = json!(values);
        assert!(decode_entry(&invalid.to_string(), &baseline).is_err());
    }
    let duplicate = line.replace("\"behavior\":", "\"behavior\":\"old\",\"behavior\":");
    assert!(decode_entry(&duplicate, &baseline).is_err());
}

#[test]
fn updates_cannot_be_committed_during_generation_or_before_tool_results_close() {
    let entries = decode_history(include_str!("fixtures/v2/tools.jsonl")).unwrap();
    let generation = entries
        .iter()
        .position(|entry| {
            matches!(
                entry.payload,
                EntryPayload::GenStarted(GenStarted {
                    purpose: GenPurpose::Conversation,
                    ..
                })
            )
        })
        .unwrap();
    let finished = entries
        .iter()
        .position(|entry| {
            matches!(
                entry.payload,
                EntryPayload::GenEnded(GenEnded {
                    status: GenStatus::Completed,
                    ..
                })
            )
        })
        .unwrap();
    let tool_finished = entries
        .iter()
        .rposition(|entry| matches!(entry.payload, EntryPayload::ToolOutcome(_)))
        .unwrap();
    for index in [generation, finished] {
        let mut prefix = entries[..=index].to_vec();
        append(&mut prefix, SystemContextUpdate::Baseline(initial()));
        assert!(validate_history(&prefix).is_err());
    }
    let mut prefix = entries[..=tool_finished].to_vec();
    append(&mut prefix, SystemContextUpdate::Baseline(initial()));
    validate_history(&prefix).unwrap();
}
