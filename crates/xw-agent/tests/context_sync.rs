use std::collections::BTreeMap;

use xw_agent::{plan_system_context_update, rebuild_context, sync_system_context};
use xw_agent_rollout::{Journal, RolloutError, RolloutStore, TestFault, WriterState};
use xw_agent_types::*;

fn tool(name: &str, kind: &str) -> ToolDeclaration {
    ToolDeclaration {
        name: name.into(),
        description: format!("Synthetic {name}"),
        parameters_json: format!(
            r#"{{"type":"object","properties":{{"value":{{"type":"{kind}"}}}}}}"#,
        ),
        constrained_sampling_json: None,
    }
}

fn context() -> SystemContext {
    SystemContext {
        instructions: BTreeMap::from([
            ("behavior".into(), "Use the available tools.".into()),
            ("environment".into(), "Synthetic workspace.".into()),
        ]),
        tools: vec![tool("Read", "string"), tool("Write", "string")],
    }
}

fn create(store: &RolloutStore) -> Journal {
    store
        .create(
            SessionId::new(),
            1000,
            SessionMeta {
                model_ref: Some("fixture".into()),
                provider_name: None,
                model_name: None,
                reasoning: None,
            },
        )
        .unwrap()
}

fn rebuild(journal: &Journal) -> xw_agent::RebuiltContext {
    rebuild_context(
        journal.entries(),
        &ContextBoundary {
            through_entry_id: journal.entries().last().map(|entry| entry.entry_id),
            after_turn_id: None,
        },
    )
    .unwrap()
}

#[test]
fn baseline_deltas_unchanged_and_reopen_preserve_the_committed_prefix() {
    let directory = tempfile::tempdir().unwrap();
    let store = RolloutStore::new(directory.path());
    let mut journal = create(&store);
    let id = journal.entries()[0].session_id;
    let initial = context();
    assert!(rebuild(&journal).system_context.is_none());

    let baseline = sync_system_context(&mut journal, &initial, 1001)
        .unwrap()
        .unwrap();
    assert!(matches!(
        baseline.payload,
        EntryPayload::SystemContext(SystemContextUpdate::Baseline(_))
    ));
    let original_bytes = std::fs::read(journal.path()).unwrap();
    assert!(
        sync_system_context(&mut journal, &initial, 1002)
            .unwrap()
            .is_none()
    );
    assert_eq!(std::fs::read(journal.path()).unwrap(), original_bytes);

    let mut desired = initial.clone();
    desired.instructions.remove("environment");
    desired
        .instructions
        .insert("behavior".into(), "Updated behavior.".into());
    desired.tools[0] = tool("Read", "number");
    desired.tools.remove(1);
    desired.tools.push(tool("Edit", "string"));
    let change = sync_system_context(&mut journal, &desired, 1003)
        .unwrap()
        .unwrap();
    let EntryPayload::SystemContext(SystemContextUpdate::Delta(delta)) = &change.payload else {
        panic!("expected one delta");
    };
    assert_eq!(delta.instructions.keys().collect::<Vec<_>>(), ["behavior"]);
    assert_eq!(delta.instructions_removed, ["environment"]);
    assert_eq!(delta.tools_removed, ["Read", "Write"]);
    assert_eq!(
        delta
            .tools_added
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        ["Edit", "Read"]
    );
    assert!(
        std::fs::read(journal.path())
            .unwrap()
            .starts_with(&original_bytes)
    );
    assert!(
        rebuild(&journal)
            .system_context
            .unwrap()
            .has_same_content(&desired)
    );
    drop(journal);

    let (mut journal, _) = store.open(id).unwrap();
    let before = journal.entries().to_vec();
    assert!(
        sync_system_context(&mut journal, &desired, 1004)
            .unwrap()
            .is_none()
    );
    assert_eq!(journal.entries(), before);
    desired.tools.clear();
    sync_system_context(&mut journal, &desired, 1005)
        .unwrap()
        .unwrap();
    assert!(
        rebuild(&journal)
            .system_context
            .unwrap()
            .has_same_content(&desired)
    );
}

#[test]
fn an_empty_baseline_is_established_once_and_can_later_receive_tools() {
    let directory = tempfile::tempdir().unwrap();
    let store = RolloutStore::new(directory.path());
    let mut journal = create(&store);
    let empty = SystemContext::default();
    sync_system_context(&mut journal, &empty, 1001)
        .unwrap()
        .unwrap();
    assert_eq!(rebuild(&journal).system_context, Some(empty.clone()));
    assert!(
        sync_system_context(&mut journal, &empty, 1002)
            .unwrap()
            .is_none()
    );

    let change = sync_system_context(&mut journal, &context(), 1003)
        .unwrap()
        .unwrap();
    assert!(matches!(
        change.payload,
        EntryPayload::SystemContext(SystemContextUpdate::Delta(_))
    ));
}

#[test]
fn schema_replacement_contains_only_the_changed_tool() {
    let initial = context();
    let mut desired = initial.clone();
    desired.tools[0] = tool("Read", "number");
    let update = plan_system_context_update(Some(&initial), &desired)
        .unwrap()
        .unwrap();
    let SystemContextUpdate::Delta(delta) = &update else {
        panic!()
    };
    assert!(delta.instructions.is_empty());
    assert!(delta.instructions_removed.is_empty());
    assert_eq!(delta.tools_removed, ["Read"]);
    assert_eq!(delta.tools_added, [desired.tools[0].clone()]);
    assert!(
        update
            .apply(Some(&initial))
            .unwrap()
            .has_same_content(&desired)
    );
}

#[test]
fn declaration_order_and_json_key_order_do_not_produce_updates() {
    let mut initial = context();
    initial.tools[0].constrained_sampling_json = Some(r#"{"a":false,"b":{}}"#.into());
    let mut desired = initial.clone();
    desired.tools[0].parameters_json =
        r#"{ "properties": { "value": { "type": "string" } }, "type": "object" }"#.into();
    desired.tools[0].constrained_sampling_json = Some(r#"{"b":{}, "a":false}"#.into());
    desired.tools.reverse();
    assert!(
        plan_system_context_update(Some(&initial), &desired)
            .unwrap()
            .is_none()
    );

    desired.tools[0].description.push_str(" Changed.");
    assert!(
        plan_system_context_update(Some(&initial), &desired)
            .unwrap()
            .is_some()
    );
}

#[test]
fn large_schema_constants_are_compared_without_rounding_or_rewriting() {
    let mut initial = context();
    initial.tools[0].parameters_json =
        r#"{"type":"object","properties":{"value":{"const":18446744073709551616}}}"#.into();
    let mut desired = initial.clone();
    desired.tools[0].parameters_json =
        r#"{"properties":{"value":{"const":18446744073709551617}},"type":"object"}"#.into();
    let update = plan_system_context_update(Some(&initial), &desired)
        .unwrap()
        .unwrap();
    assert_eq!(
        update.apply(Some(&initial)).unwrap().tools[0].parameters_json,
        desired.tools[0].parameters_json
    );
}

#[test]
fn failed_commits_never_advance_state_and_require_repair_before_retry() {
    for fault in [
        TestFault::BeforeWrite,
        TestFault::Partial,
        TestFault::AfterLine,
        TestFault::Sync,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let store = RolloutStore::new(directory.path());
        let mut journal = create(&store);
        let initial = context();
        sync_system_context(&mut journal, &initial, 1001).unwrap();
        let before = journal.entries().to_vec();
        let mut desired = initial.clone();
        desired.tools[0] = tool("Read", "number");
        let expected = plan_system_context_update(Some(&initial), &desired)
            .unwrap()
            .unwrap();

        journal.fail_next_append(fault);
        assert!(sync_system_context(&mut journal, &desired, 1002).is_err());
        assert_eq!(journal.entries(), before);
        assert!(
            rebuild(&journal)
                .system_context
                .unwrap()
                .has_same_content(&initial)
        );
        assert_eq!(journal.state(), WriterState::NeedsCheck);
        assert!(matches!(
            sync_system_context(&mut journal, &initial, 1003),
            Err(RolloutError::NeedsCheck)
        ));

        journal.check_after_failure().unwrap();
        let committed = sync_system_context(&mut journal, &desired, 1004)
            .unwrap()
            .unwrap();
        assert_eq!(committed.payload, EntryPayload::SystemContext(expected));
        assert!(
            sync_system_context(&mut journal, &desired, 1005)
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn context_boundaries_restore_only_updates_already_committed_at_that_boundary() {
    let directory = tempfile::tempdir().unwrap();
    let store = RolloutStore::new(directory.path());
    let mut journal = create(&store);
    let initial = context();
    let first = sync_system_context(&mut journal, &initial, 1001)
        .unwrap()
        .unwrap();
    let mut desired = initial.clone();
    desired.tools.clear();
    sync_system_context(&mut journal, &desired, 1002)
        .unwrap()
        .unwrap();

    let earlier = rebuild_context(
        journal.entries(),
        &ContextBoundary {
            through_entry_id: Some(first.entry_id),
            after_turn_id: None,
        },
    )
    .unwrap();
    assert!(earlier.system_context.unwrap().has_same_content(&initial));
    assert!(
        rebuild(&journal)
            .system_context
            .unwrap()
            .has_same_content(&desired)
    );
    assert!(earlier.messages.is_empty());
}

#[test]
fn baseline_is_not_repeated_across_runs_or_compaction_checkpoints() {
    let mut entries = decode_history(include_str!("fixtures/compaction.jsonl")).unwrap();
    let initial = context();
    let baseline = JournalEntry {
        schema_version: HISTORY_VERSION,
        session_id: entries[0].session_id,
        entry_id: EntryId::new(),
        sequence: Sequence(3),
        timestamp_ms: 1000,
        payload: EntryPayload::SystemContext(SystemContextUpdate::Baseline(initial.clone())),
    };
    entries.insert(2, baseline);
    for (index, entry) in entries.iter_mut().enumerate() {
        entry.sequence = Sequence(index as u64 + 1);
        if let EntryPayload::Compacted(checkpoint) = &mut entry.payload {
            checkpoint.system_context = Some(initial.clone());
        }
    }
    validate_history(&entries).unwrap();
    let encoded = encode_history(&entries).unwrap();
    assert_eq!(decode_history(&encoded).unwrap(), entries);

    for upper in 3..=entries.len() {
        let rebuilt = rebuild_context(
            &entries,
            &ContextBoundary {
                through_entry_id: Some(entries[upper - 1].entry_id),
                after_turn_id: None,
            },
        )
        .unwrap();
        assert!(
            plan_system_context_update(rebuilt.system_context.as_ref(), &initial)
                .unwrap()
                .is_none()
        );
    }

    let last = entries.last_mut().unwrap();
    let EntryPayload::Compacted(checkpoint) = &mut last.payload else {
        panic!()
    };
    checkpoint.system_context = None;
    assert!(validate_history(&entries).is_err());
}
