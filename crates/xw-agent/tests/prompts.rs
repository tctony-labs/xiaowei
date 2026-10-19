use xw_agent::{build_chat_system_context, rebuild_context, sync_system_context};
use xw_agent_rollout::{RolloutStore, TestFault};
use xw_agent_types::*;

fn tool(name: &str) -> ToolDeclaration {
    ToolDeclaration {
        name: name.into(),
        description: "Synthetic tool declaration.".into(),
        parameters_json: r#"{"type":"object","properties":{}}"#.into(),
        constrained_sampling_json: None,
    }
}

#[test]
fn only_exposed_tools_contribute_rules_and_declarations_remain_unchanged() {
    let context = build_chat_system_context(Vec::new()).unwrap();
    assert_eq!(context.instructions.len(), 1);
    assert!(context.instructions["base"].starts_with("你是小微"));
    assert!(context.tools.is_empty());

    for name in ["Read", "Write", "Edit", "unrelated"] {
        let declaration = tool(name);
        let context = build_chat_system_context(vec![declaration.clone()]).unwrap();
        assert_eq!(context.tools, [declaration]);
        let rule_names: Vec<_> = context
            .instructions
            .keys()
            .filter(|name| name.as_str() != "base")
            .map(String::as_str)
            .collect();
        let expected = if name == "unrelated" {
            Vec::new()
        } else {
            vec![format!("tool.{name}")]
        };
        assert_eq!(rule_names, expected);
    }

    assert!(build_chat_system_context(vec![tool("Read"), tool("Read")]).is_err());
}

#[test]
fn rule_changes_commit_with_tool_changes_and_survive_reopen_without_a_new_baseline() {
    let directory = tempfile::tempdir().unwrap();
    let store = RolloutStore::new(directory.path());
    let id = SessionId::new();
    let mut journal = store
        .create(
            id,
            1000,
            SessionMeta {
                model_ref: Some("fixture".into()),
                provider_name: None,
                model_name: None,
                reasoning: None,
            },
        )
        .unwrap();
    let base = build_chat_system_context(Vec::new()).unwrap();
    sync_system_context(&mut journal, &base, 1001)
        .unwrap()
        .unwrap();
    let before = journal.entries().to_vec();
    assert!(
        sync_system_context(&mut journal, &base, 1002)
            .unwrap()
            .is_none()
    );
    assert_eq!(journal.entries(), before);

    let filesystem =
        build_chat_system_context(vec![tool("Read"), tool("Write"), tool("Edit")]).unwrap();
    let added = sync_system_context(&mut journal, &filesystem, 1003)
        .unwrap()
        .unwrap();
    let EntryPayload::SystemContext(SystemContextUpdate::Delta(delta)) = added.payload else {
        panic!("expected a delta");
    };
    assert_eq!(
        delta
            .instructions
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["tool.Edit", "tool.Read", "tool.Write"]
    );
    assert_eq!(delta.tools_added.len(), 3);
    assert!(!delta.instructions.contains_key("base"));
    drop(journal);

    let (mut journal, _) = store.open(id).unwrap();
    assert!(
        sync_system_context(&mut journal, &filesystem, 1004)
            .unwrap()
            .is_none()
    );
    let removed = sync_system_context(&mut journal, &base, 1005)
        .unwrap()
        .unwrap();
    let EntryPayload::SystemContext(SystemContextUpdate::Delta(delta)) = removed.payload else {
        panic!("expected a delta");
    };
    assert_eq!(
        delta.instructions_removed,
        ["tool.Edit", "tool.Read", "tool.Write"]
    );
    assert_eq!(delta.tools_removed, ["Edit", "Read", "Write"]);

    let rebuilt = rebuild_context(
        journal.entries(),
        &ContextBoundary {
            through_entry_id: journal.entries().last().map(|entry| entry.entry_id),
            after_turn_id: None,
        },
    )
    .unwrap();
    assert_eq!(rebuilt.system_context, Some(base));
}

#[test]
fn failed_rule_commit_preserves_the_previous_base_and_tool_set() {
    let directory = tempfile::tempdir().unwrap();
    let store = RolloutStore::new(directory.path());
    let mut journal = store
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
        .unwrap();
    let base = build_chat_system_context(Vec::new()).unwrap();
    sync_system_context(&mut journal, &base, 1001).unwrap();
    let before = journal.entries().to_vec();
    let desired = build_chat_system_context(vec![tool("Read")]).unwrap();
    journal.fail_next_append(TestFault::Sync);
    assert!(sync_system_context(&mut journal, &desired, 1002).is_err());
    assert_eq!(journal.entries(), before);
    let rebuilt = rebuild_context(
        journal.entries(),
        &ContextBoundary {
            through_entry_id: journal.entries().last().map(|entry| entry.entry_id),
            after_turn_id: None,
        },
    )
    .unwrap();
    assert_eq!(rebuilt.system_context, Some(base));
}
