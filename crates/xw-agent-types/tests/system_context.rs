use serde_json::json;
use xw_agent_types::*;

#[test]
fn legacy_named_instructions_restore_in_the_previous_order() {
    let mut entries = decode_history(include_str!("fixtures/v2/text.jsonl")).unwrap();
    let history = entries.clone();
    append(&mut entries, SystemContextUpdate::Baseline(initial()));
    let line = encode_entry(entries.last().unwrap(), &history).unwrap();
    let mut legacy: serde_json::Value = serde_json::from_str(&line).unwrap();
    legacy["payload"]["data"]["data"]["instructions"] =
        json!({ "z": "later", "base": "first", "a": "second" });
    let entry = decode_entry(&legacy.to_string(), &history).unwrap();
    let EntryPayload::SystemContext(update) = entry.payload else {
        panic!("expected system context");
    };
    let restored = update.apply(None).unwrap();
    assert_eq!(
        restored.instructions.keys().collect::<Vec<_>>(),
        ["a", "base", "z"]
    );
    let encoded = serde_json::to_value(update).unwrap();
    assert_eq!(
        encoded["data"]["instructions"][1],
        json!({ "name": "base", "content": "first" })
    );
}

fn initial() -> SystemContext {
    SystemContext {
        instructions: [("behavior".into(), "Synthetic instruction.".into())]
            .into_iter()
            .collect(),
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
            instructions: [("behavior".into(), "Updated behavior.".into())]
                .into_iter()
                .collect(),
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
fn run_tools_are_restored_from_its_boundary_and_explicit_tools_take_precedence() {
    let fixture = include_str!("fixtures/v2/tools.jsonl");
    let original = decode_history(fixture).unwrap();
    let mut started = original[3].clone();
    let EntryPayload::RunStarted(run) = &mut started.payload else {
        panic!("expected fixture RunStarted");
    };
    let tools = run.context.tools.clone();
    let mut prefix = original[..2].to_vec();
    append(
        &mut prefix,
        SystemContextUpdate::Baseline(SystemContext {
            tools: tools.clone(),
            ..Default::default()
        }),
    );
    run.base_context.through_entry_id = Some(prefix.last().unwrap().entry_id);
    append(
        &mut prefix,
        SystemContextUpdate::Delta(SystemContextDelta {
            tools_removed: tools.iter().map(|tool| tool.name.clone()).collect(),
            ..Default::default()
        }),
    );
    let mut input = original[2].clone();
    input.sequence = Sequence(prefix.len() as u64 + 1);
    prefix.push(input);
    started.sequence = Sequence(prefix.len() as u64 + 1);

    let compact = encode_entry(&started, &prefix).unwrap();
    assert!(!compact.contains("\"tools\":"));
    assert_eq!(decode_entry(&compact, &prefix).unwrap(), started);

    let mut invalid: serde_json::Value = serde_json::from_str(&compact).unwrap();
    invalid["payload"]["data"]["context"]["tools"] = serde_json::Value::Null;
    assert!(decode_entry(&invalid.to_string(), &prefix).is_err());

    let mut reversed = tools;
    reversed.reverse();
    for declarations in [reversed, vec![]] {
        let mut explicit = started.clone();
        let EntryPayload::RunStarted(run) = &mut explicit.payload else {
            unreachable!();
        };
        run.context.tools = declarations;
        let encoded = encode_entry(&explicit, &prefix).unwrap();
        assert!(encoded.contains("\"tools\":"));
        assert_eq!(decode_entry(&encoded, &prefix).unwrap(), explicit);
    }
}

#[test]
fn missing_run_tools_require_a_system_context_at_the_boundary() {
    let fixture = include_str!("fixtures/v2/tools.jsonl");
    let history = decode_history(fixture).unwrap();
    let mut line: serde_json::Value =
        serde_json::from_str(fixture.lines().nth(3).unwrap()).unwrap();
    let context = line["payload"]["data"]["context"].as_object_mut().unwrap();
    context.remove("tools").unwrap();
    assert_eq!(
        decode_entry(&line.to_string(), &history[..3]).unwrap_err(),
        FormatError::InvalidStructure {
            path: Some("context.tools".into()),
        }
    );
}

#[test]
fn run_tools_can_be_restored_from_a_compaction_snapshot() {
    let mut history = decode_history(include_str!("fixtures/v2/compaction.jsonl")).unwrap();
    let snapshot = initial();
    let checkpoint = history.last_mut().unwrap();
    let EntryPayload::Compacted(compacted) = &mut checkpoint.payload else {
        panic!("expected fixture checkpoint");
    };
    compacted.system_context = Some(snapshot.clone());
    let checkpoint_id = checkpoint.entry_id;
    let prefix = &history[..history.len() - 1];
    let encoded = encode_entry(history.last().unwrap(), prefix).unwrap();
    let mut legacy: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    legacy["payload"]["data"]["system_context"]["instructions"] =
        json!({ "behavior": "Synthetic instruction." });
    assert_eq!(
        decode_entry(&legacy.to_string(), prefix).unwrap(),
        *history.last().unwrap()
    );

    let input_id = InputId::new();
    let mut accepted = history[2].clone();
    accepted.entry_id = EntryId::new();
    accepted.sequence = Sequence(history.len() as u64 + 1);
    let EntryPayload::InputAccepted(input) = &mut accepted.payload else {
        panic!("expected fixture input");
    };
    input.input_id = input_id;
    input.message.input_id = Some(input_id);
    input.message.message_id = MessageId::new();
    for id in &mut input.message.block_ids {
        *id = BlockId::new();
    }
    history.push(accepted);

    let mut started = history[3].clone();
    started.entry_id = EntryId::new();
    started.sequence = Sequence(history.len() as u64 + 1);
    let EntryPayload::RunStarted(run) = &mut started.payload else {
        panic!("expected fixture RunStarted");
    };
    run.run_id = RunId::new();
    run.cause = RunCause::Send { input_id };
    run.base_context.through_entry_id = Some(checkpoint_id);
    run.context.tools = snapshot.tools;

    let encoded = encode_entry(&started, &history).unwrap();
    assert!(!encoded.contains("\"tools\":"));
    assert_eq!(decode_entry(&encoded, &history).unwrap(), started);
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
    baseline.instructions = [("secret instruction".into(), " ".into())]
        .into_iter()
        .collect();
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
    let duplicate = line.replace(
        "\"instructions\":[{\"content\":\"Synthetic instruction.\",\"name\":\"behavior\"}]",
        "\"instructions\":{\"behavior\":\"old\",\"behavior\":\"Synthetic instruction.\"}",
    );
    assert_ne!(duplicate, line);
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
