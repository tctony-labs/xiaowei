use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::stream;
use xw_agent::{
    AgentHost, AgentService, CancellationToken, GenerationEvent, GenerationFuture,
    GenerationRequest, GenerationStream, InputSource, SourceKind, protocol::*,
};
use xw_agent_types::{
    AgentMessage as History, AssistantMessage, ClientRequestId, ContentBlock, FinishReason,
    InputId, TokenUsage, UsageCost,
};

struct Host {
    messages: Mutex<VecDeque<AssistantMessage>>,
    requests: Mutex<Vec<GenerationRequest>>,
}

impl Host {
    fn new(messages: Vec<AssistantMessage>) -> Arc<Self> {
        Arc::new(Self {
            messages: Mutex::new(messages.into()),
            requests: Mutex::new(vec![]),
        })
    }
}

impl AgentHost for Host {
    fn get_model_info(&self, _: String) -> xw_agent::ModelInfoFuture {
        Box::pin(async { Err(xw_agent::ModelInfoError::Unavailable) })
    }

    fn get_auxiliary_model_ref(&self) -> xw_agent::AuxiliaryModelRefFuture {
        Box::pin(async { Ok(None) })
    }

    fn generate(&self, request: GenerationRequest, _: CancellationToken) -> GenerationFuture {
        self.requests.lock().unwrap().push(request);
        let message = self
            .messages
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected generation");
        Box::pin(async move {
            Ok(
                Box::pin(stream::iter(vec![Ok(GenerationEvent::Finished(message))]))
                    as GenerationStream,
            )
        })
    }
}

fn message(calls: &[(&str, &str)], text: &str) -> AssistantMessage {
    let mut content: Vec<_> = calls
        .iter()
        .enumerate()
        .map(|(index, (name, arguments))| ContentBlock::ToolCall {
            id: format!("call-{index}"),
            name: (*name).into(),
            arguments_json: Some((*arguments).into()),
            thought_signature: None,
            namespace: None,
        })
        .collect();
    if !text.is_empty() {
        content.push(ContentBlock::Text {
            text: text.into(),
            signature: None,
        });
    }
    AssistantMessage {
        content,
        api: "fixture".into(),
        provider: "fixture".into(),
        model_id: "test".into(),
        usage: Some(TokenUsage {
            input: 12,
            output: 4,
            cache_read: 0,
            cache_write: 0,
            total: 16,
            reasoning: None,
            cache_write_1h: None,
            cost: Some(UsageCost {
                input: 0.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
                total: 0.0,
            }),
        }),
        stop_reason: if calls.is_empty() {
            FinishReason::Stop
        } else {
            FinishReason::ToolUse
        },
        timestamp_ms: 1,
        response_id: None,
        response_model: None,
        provider_thinking_level: None,
        raw_stop_reason: None,
        end_turn: None,
    }
}

async fn create(service: &AgentService, cwd: Option<String>) -> AgentSession {
    service
        .create_session(CreateSessionRequest {
            client_request_id: ClientRequestId::new().to_string(),
            cwd,
            config: Some(AgentModelConfig {
                model_ref: "test".into(),
                reasoning: None,
            }),
            ..Default::default()
        })
        .await
        .unwrap()
        .session
        .unwrap()
}

async fn begin(service: &AgentService, session: &AgentSession) -> AgentRun {
    service
        .start_run(
            StartRunRequest {
                session_id: session.session_id.clone(),
                input_id: InputId::new().to_string(),
                input: vec![AgentUserInput {
                    content: Some(agent_user_input::Content::Text("test".into())),
                }],
                ..Default::default()
            },
            caller("desktop"),
        )
        .await
        .unwrap()
        .run
        .unwrap()
}

fn caller(name: &str) -> InputSource {
    InputSource {
        kind: SourceKind::Desktop,
        principal_id: name.into(),
    }
}

async fn opened(events: &mut xw_agent::EventSubscription) -> AgentInteraction {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(agent_event::Payload::InteractionUpdated(update)) =
                events.recv().await.unwrap().unwrap().payload
            {
                return update.interaction.unwrap();
            }
        }
    })
    .await
    .unwrap()
}

async fn terminal(events: &mut xw_agent::EventSubscription) -> AgentRun {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(agent_event::Payload::RunCompleted(end)) =
                events.recv().await.unwrap().unwrap().payload
            {
                return end.run.unwrap();
            }
        }
    })
    .await
    .unwrap()
}

fn reply(
    session: &AgentSession,
    view: &AgentInteraction,
    allow: Option<bool>,
) -> RespondInteractionRequest {
    RespondInteractionRequest {
        session_id: session.session_id.clone(),
        interaction_id: view.interaction_id.clone(),
        expected_revision: 1,
        client_request_id: ClientRequestId::new().to_string(),
        answer: Some(AgentInteractionAnswer {
            answer: Some(match allow {
                Some(allow) => {
                    agent_interaction_answer::Answer::Permission(AgentPermissionAnswer { allow })
                }
                None => agent_interaction_answer::Answer::Question(AgentQuestionAnswer {
                    selected_indices: vec![1],
                    text: Some("补充信息".into()),
                }),
            }),
        }),
    }
}

#[tokio::test]
async fn independent_receipts_do_not_resolve_and_first_durable_decision_continues_the_same_run() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::new(vec![
        message(
            &[(
                "AskUserQuestion",
                r#"{"question":"选择","options":["A","B"]}"#,
            )],
            "",
        ),
        message(&[], "final"),
    ]);
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let session = create(&service, None).await;
    let mut events = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .await
        .unwrap();
    let mut desktop = service
        .observe_interactions(
            ObserveInteractionsRequest {
                session_id: session.session_id.clone(),
            },
            "desktop".into(),
        )
        .await
        .unwrap();
    let mut phone = service
        .observe_interactions(
            ObserveInteractionsRequest {
                session_id: session.session_id.clone(),
            },
            "phone".into(),
        )
        .await
        .unwrap();
    let Some(interaction_delivery_event::Payload::Ready(dready)) =
        desktop.recv().await.unwrap().payload
    else {
        panic!();
    };
    let Some(interaction_delivery_event::Payload::Ready(pready)) =
        phone.recv().await.unwrap().payload
    else {
        panic!();
    };
    let accepted = begin(&service, &session).await;
    let view = opened(&mut events).await;
    let Some(interaction_delivery_event::Payload::Delivery(ddelivery)) =
        desktop.recv().await.unwrap().payload
    else {
        panic!();
    };
    let Some(interaction_delivery_event::Payload::Delivery(pdelivery)) =
        phone.recv().await.unwrap().payload
    else {
        panic!();
    };
    assert_eq!(
        ddelivery.interaction.unwrap().interaction_id,
        view.interaction_id
    );
    let receipt = AcknowledgeInteractionRequest {
        instance_id: dready.instance_id,
        observer_id: dready.observer_id,
        delivery_id: ddelivery.delivery_id,
        interaction_id: view.interaction_id.clone(),
    };
    assert!(
        service
            .acknowledge_interaction(receipt.clone(), "phone")
            .is_err()
    );
    service
        .acknowledge_interaction(receipt.clone(), "desktop")
        .unwrap();
    let mut wrong_instance = receipt.clone();
    wrong_instance.instance_id = "old-instance".into();
    assert!(
        service
            .acknowledge_interaction(wrong_instance, "desktop")
            .is_err()
    );
    let mut wrong_delivery = receipt.clone();
    wrong_delivery.interaction_id = xw_agent_types::InteractionId::new().to_string();
    assert!(
        service
            .acknowledge_interaction(wrong_delivery, "desktop")
            .is_err()
    );
    service
        .acknowledge_interaction(receipt.clone(), "desktop")
        .unwrap();
    drop(desktop);
    service.acknowledge_interaction(receipt, "desktop").unwrap();
    let snapshot = service
        .read_session(ReadSessionRequest {
            session_id: session.session_id.clone(),
            include_runs: true,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    assert!(snapshot.runs[0].generation.is_none());
    assert_eq!(host.requests.lock().unwrap().len(), 1);
    let command = reply(&session, &view, None);
    let response = service
        .respond_interaction(command.clone(), caller("phone"))
        .await
        .unwrap();
    assert_eq!(response.interaction.unwrap().revision, 2);
    service
        .respond_interaction(command.clone(), caller("phone"))
        .await
        .unwrap();
    assert!(
        service
            .respond_interaction(command.clone(), caller("desktop"))
            .await
            .is_err()
    );
    let mut competing = command;
    competing.client_request_id = ClientRequestId::new().to_string();
    assert!(
        service
            .respond_interaction(competing, caller("desktop"))
            .await
            .is_err()
    );
    // Decision precedes this observer's ACK. Its late receipt does not reopen the card.
    service
        .acknowledge_interaction(
            AcknowledgeInteractionRequest {
                instance_id: pready.instance_id,
                observer_id: pready.observer_id,
                delivery_id: pdelivery.delivery_id,
                interaction_id: view.interaction_id,
            },
            "phone",
        )
        .unwrap();
    let run = terminal(&mut events).await;
    assert_eq!(run.run_id, accepted.run_id);
    assert_eq!(run.status, AgentRunStatus::Completed as i32);
    assert_eq!(host.requests.lock().unwrap().len(), 2);
    assert!(
        host.requests.lock().unwrap()[1]
            .messages
            .iter()
            .any(|message| {
                matches!(message, History::ToolResult(result) if result.content.iter().any(|block| {
                    matches!(block, ContentBlock::Text { text, .. } if text.contains("B\n补充信息"))
                }))
            })
    );
    let snapshot = service
        .read_session(ReadSessionRequest {
            session_id: session.session_id.clone(),
            include_runs: true,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    assert_eq!(snapshot.runs.len(), 1);
    service.close().await.unwrap();
}

#[tokio::test]
async fn approved_file_scope_updates_write_edit_and_bash_in_run_and_survives_reopen() {
    // /tmp is already writable; this isolated home child tests actual denied scope.
    let home = std::env::var_os("HOME").unwrap();
    let root = tempfile::Builder::new()
        .prefix(".xw-interaction-test-")
        .tempdir_in(home)
        .unwrap();
    let target = root.path().join("approved.txt");
    let other = root.path().join("not-approved.txt");
    let permission =
        serde_json::json!({"path": target, "is_directory": false, "reason": "test"}).to_string();
    let write = serde_json::json!({"path": target, "contents": "one"}).to_string();
    let edit =
        serde_json::json!({"path": target, "old_string": "one", "new_string": "two"}).to_string();
    let mut messages = vec![
        message(&[("RequestPermission", &permission), ("Write", &write)], ""),
        message(&[("Edit", &edit)], ""),
    ];
    #[cfg(target_os = "macos")]
    {
        let path = format!("'{}'", target.to_string_lossy().replace('\'', "'\\''"));
        let args = serde_json::json!({
            "description": "permission test",
            "command": format!("printf three > {path}"),
        })
        .to_string();
        messages.push(message(&[("Bash", &args)], ""));
    }
    messages.push(message(&[], "done"));
    let restored = serde_json::json!({"path": target, "contents": "restored"}).to_string();
    let forbidden = serde_json::json!({"path": other, "contents": "bad"}).to_string();
    messages.extend([
        message(&[("Write", &restored), ("Write", &forbidden)], ""),
        message(&[], "done"),
    ]);
    let host = Host::new(messages);
    let store = root.path().join("store");
    let service = AgentService::open(host.clone(), store.clone())
        .await
        .unwrap();
    let session = create(&service, None).await;
    let mut events = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .await
        .unwrap();
    begin(&service, &session).await;
    let view = opened(&mut events).await;
    assert!(!target.exists());
    service
        .respond_interaction(reply(&session, &view, Some(true)), caller("desktop"))
        .await
        .unwrap();
    let run = terminal(&mut events).await;
    assert_eq!(
        run.status,
        AgentRunStatus::Completed as i32,
        "{:?}",
        run.error
    );
    for item in run.items {
        if let Some(agent_item::Content::ToolCall(tool)) = item.content {
            assert_eq!(
                tool.status,
                AgentToolStatus::Completed as i32,
                "{}",
                tool.output
            );
        }
    }
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        if cfg!(target_os = "macos") {
            "three"
        } else {
            "two"
        }
    );
    let before = host.requests.lock().unwrap().len();
    service.close().await.unwrap();
    drop(events);
    verify_recovery_prefixes(&store, &session.session_id);
    let service = AgentService::open(host.clone(), store).await.unwrap();
    let mut events = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(host.requests.lock().unwrap().len(), before);
    begin(&service, &session).await;
    let run = terminal(&mut events).await;
    assert_eq!(run.status, AgentRunStatus::Completed as i32);
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "restored");
    assert!(!other.exists());
    service.close().await.unwrap();
}

#[tokio::test]
async fn denying_permission_is_a_valid_result_and_never_allows_the_following_write() {
    let home = std::env::var_os("HOME").unwrap();
    let root = tempfile::Builder::new()
        .prefix(".xw-interaction-denied-")
        .tempdir_in(home)
        .unwrap();
    let target = root.path().join("denied.txt");
    let permission = serde_json::json!({
        "path": target,
        "is_directory": false,
        "reason": "test denial",
    })
    .to_string();
    let write = serde_json::json!({"path": target, "contents": "must not write"}).to_string();
    let host = Host::new(vec![
        message(&[("RequestPermission", &permission), ("Write", &write)], ""),
        message(&[], "permission denied"),
    ]);
    let service = AgentService::open(host.clone(), root.path().join("store"))
        .await
        .unwrap();
    let session = create(&service, None).await;
    let mut events = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .await
        .unwrap();
    let accepted = begin(&service, &session).await;
    let view = opened(&mut events).await;
    service
        .respond_interaction(reply(&session, &view, Some(false)), caller("desktop"))
        .await
        .unwrap();
    let run = terminal(&mut events).await;
    assert_eq!(run.run_id, accepted.run_id);
    assert_eq!(run.status, AgentRunStatus::Completed as i32);
    let tools: Vec<_> = run
        .items
        .iter()
        .filter_map(|item| match &item.content {
            Some(agent_item::Content::ToolCall(tool)) => Some(tool),
            _ => None,
        })
        .collect();
    assert_eq!(tools[0].status, AgentToolStatus::Completed as i32);
    assert_eq!(tools[1].status, AgentToolStatus::Failed as i32);
    assert!(!target.exists());
    assert_eq!(host.requests.lock().unwrap().len(), 2);
    service.close().await.unwrap();
}

#[tokio::test]
async fn stopping_a_question_expires_it_and_closes_the_tool_without_a_new_generation() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::new(vec![
        message(&[("AskUserQuestion", r#"{"question":"waiting?"}"#)], ""),
        message(&[], "new run"),
    ]);
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let session = create(&service, None).await;
    let mut events = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .await
        .unwrap();
    let run = begin(&service, &session).await;
    let view = opened(&mut events).await;
    service
        .interrupt_run(InterruptRunRequest {
            session_id: session.session_id.clone(),
            run_id: run.run_id,
        })
        .unwrap();
    assert!(
        service
            .respond_interaction(reply(&session, &view, Some(true)), caller("desktop"))
            .await
            .is_err()
    );
    let run = terminal(&mut events).await;
    assert_eq!(run.status, AgentRunStatus::Interrupted as i32);
    let tool = run
        .items
        .iter()
        .find_map(|item| match &item.content {
            Some(agent_item::Content::ToolCall(tool)) => Some(tool),
            _ => None,
        })
        .unwrap();
    assert_eq!(tool.status, AgentToolStatus::Cancelled as i32);
    assert_eq!(
        tool.interaction.as_ref().unwrap().status,
        AgentInteractionStatus::Expired as i32
    );
    assert_eq!(host.requests.lock().unwrap().len(), 1);
    begin(&service, &session).await;
    assert_eq!(
        terminal(&mut events).await.status,
        AgentRunStatus::Completed as i32
    );
    service.close().await.unwrap();
}

fn verify_recovery_prefixes(root: &std::path::Path, session_id: &str) {
    use xw_agent_types::{EntryPayload, ToolStatus};
    let store = xw_agent_rollout::RolloutStore::new(root);
    let (journal, _) = store.open(session_id.parse().unwrap()).unwrap();
    let entries = journal.entries().to_vec();
    drop(journal);
    for (index, entry) in entries.iter().enumerate() {
        let (id, completed) = match &entry.payload {
            EntryPayload::InteractionOpened(opened) => (opened.interaction_id, false),
            EntryPayload::InteractionResolved(resolved) => (resolved.interaction_id, true),
            _ => continue,
        };
        let opened = entries
            .iter()
            .find_map(|entry| match &entry.payload {
                EntryPayload::InteractionOpened(opened) if opened.interaction_id == id => {
                    Some(opened)
                }
                _ => None,
            })
            .unwrap();
        let copy = tempfile::tempdir().unwrap();
        let EntryPayload::Meta(meta) = &entries[1].payload else {
            panic!();
        };
        let store = xw_agent_rollout::RolloutStore::new(copy.path());
        let mut journal = store
            .create(entries[0].session_id, entries[0].timestamp_ms, meta.clone())
            .unwrap();
        for entry in &entries[2..=index] {
            journal.append_entry(entry.clone()).unwrap();
        }
        let recovery = xw_agent::settle_interrupted(
            &mut journal,
            None,
            entries.last().unwrap().timestamp_ms + 1,
        )
        .unwrap();
        assert!(!recovery.tools.contains(&opened.tool_id));
        assert!(recovery.interactions.is_empty());
        let outcome = journal
            .entries()
            .iter()
            .find_map(|entry| match &entry.payload {
                EntryPayload::ToolOutcome(outcome) if outcome.tool_id == opened.tool_id => {
                    Some(outcome)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(
            outcome.status,
            if completed {
                ToolStatus::Completed
            } else {
                ToolStatus::Cancelled
            }
        );
    }
}
