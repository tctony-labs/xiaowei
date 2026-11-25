use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::stream;
use tokio::sync::mpsc;
use xw_agent_rollout::{TestFault, WriterState};
use xw_agent_types as domain;

use crate::{protocol::*, *};

#[derive(Default)]
struct Host {
    calls: Mutex<Vec<GenerationRequest>>,
    pending: Mutex<Vec<mpsc::UnboundedSender<GenerationEvent>>>,
}

impl AgentHost for Host {
    fn get_model_info(&self, model_ref: String) -> ModelInfoFuture {
        Box::pin(async move {
            Ok(ModelInfo {
                model_ref,
                provider_name: "fixture".into(),
                model_name: "fixture".into(),
                capabilities: domain::ModelCapabilities {
                    input_modalities: vec![domain::InputModality::Text],
                    supports_reasoning: false,
                    context_window: 16_000,
                    max_output_tokens: 4096,
                },
            })
        })
    }

    fn get_auxiliary_model_ref(&self) -> AuxiliaryModelRefFuture {
        Box::pin(async { Ok(Some("small".into())) })
    }

    fn generate(&self, request: GenerationRequest, _: CancellationToken) -> GenerationFuture {
        self.calls.lock().unwrap().push(request);
        let (tx, rx) = mpsc::unbounded_channel();
        self.pending.lock().unwrap().push(tx);
        Box::pin(async move {
            Ok(Box::pin(stream::unfold(rx, |mut rx| async {
                rx.recv().await.map(|event| (Ok(event), rx))
            })) as GenerationStream)
        })
    }
}

struct Extract;

impl AgentTool for Extract {
    fn declaration(&self) -> domain::ToolDeclaration {
        domain::ToolDeclaration {
            name: "Extract".into(),
            description: "fixture extraction".into(),
            parameters_json: r#"{"type":"object","properties":{}}"#.into(),
            constrained_sampling_json: None,
        }
    }

    fn recovery_policy(&self) -> RecoveryPolicy {
        RecoveryPolicy::CancelPending
    }

    fn execute<'a>(
        &'a self,
        _: &'a str,
        context: &'a dyn ToolContext,
    ) -> ToolFuture<'a, xw_agent_runtime::tools::ToolOutput> {
        Box::pin(async move {
            let text = context
                .extract_text("page".into(), "extract".into())
                .await?;
            Ok(xw_agent_runtime::tools::ToolOutput {
                text,
                metadata_json: None,
            })
        })
    }
}

fn registrations() -> Vec<ToolRegistration> {
    vec![ToolRegistration::new("fixture.extract", Arc::new(Extract))]
}

fn message(tool: bool) -> domain::AssistantMessage {
    let entries = domain::decode_history(include_str!("../tests/fixtures/tools.jsonl")).unwrap();
    let mut message = entries
        .into_iter()
        .find_map(|entry| match entry.payload {
            domain::EntryPayload::Message(message) => match message.message {
                domain::AgentMessage::Assistant(message) => Some(message),
                _ => None,
            },
            _ => None,
        })
        .unwrap();
    message.stop_reason = if tool {
        domain::FinishReason::ToolUse
    } else {
        domain::FinishReason::Stop
    };
    message.content = if tool {
        vec![domain::ContentBlock::ToolCall {
            id: "extract-call".into(),
            name: "Extract".into(),
            arguments_json: Some("{}".into()),
            thought_signature: None,
            namespace: None,
        }]
    } else {
        vec![domain::ContentBlock::Text {
            text: "summary".into(),
            signature: None,
        }]
    };
    message
}

async fn wait(check: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !check() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn start(service: &AgentService) -> domain::SessionId {
    service.set_tools(registrations()).unwrap();
    let session = service
        .create_session(CreateSessionRequest {
            client_request_id: domain::ClientRequestId::new().to_string(),
            config: Some(AgentModelConfig {
                model_ref: "chat".into(),
                reasoning: None,
            }),
            ..Default::default()
        })
        .await
        .unwrap()
        .session
        .unwrap();
    service
        .set_session_title(SetSessionTitleRequest {
            session_id: session.session_id.clone(),
            title: "fixture".into(),
        })
        .await
        .unwrap();
    service
        .start_run(
            StartRunRequest {
                session_id: session.session_id.clone(),
                input_id: domain::InputId::new().to_string(),
                input: vec![AgentUserInput {
                    content: Some(agent_user_input::Content::Text("query".into())),
                }],
                ..Default::default()
            },
            InputSource {
                kind: SourceKind::Internal,
                principal_id: "fixture".into(),
            },
        )
        .await
        .unwrap();
    session.session_id.parse().unwrap()
}

#[tokio::test]
async fn auxiliary_commit_failures_stop_generation_and_recovery_never_replays_extraction() {
    for after in 3..=7 {
        let root = tempfile::tempdir().unwrap();
        let host = Arc::new(Host::default());
        let service = AgentService::open(host.clone(), root.path().into())
            .await
            .unwrap();
        let id = start(&service).await;
        wait(|| host.pending.lock().unwrap().len() == 1).await;
        service
            .state()
            .unwrap()
            .sessions
            .get_mut(&id)
            .unwrap()
            .journal
            .as_mut()
            .unwrap()
            .fail_append_after(after, TestFault::Partial);
        host.pending.lock().unwrap()[0]
            .send(GenerationEvent::Finished(message(true)))
            .unwrap();
        if after >= 4 {
            wait(|| host.pending.lock().unwrap().len() == 2).await;
            host.pending.lock().unwrap()[1]
                .send(GenerationEvent::FirstSseReceived { received_at_ms: 1 })
                .unwrap();
            host.pending.lock().unwrap()[1]
                .send(GenerationEvent::Finished(message(false)))
                .unwrap();
        }
        wait(|| service.state().unwrap().sessions[&id].active.is_none()).await;
        {
            let state = service.state().unwrap();
            let session = &state.sessions[&id];
            assert_eq!(session.view.runs[0].status, AgentRunStatus::Failed as i32);
            assert!(session.failed_run.is_some());
            assert_eq!(
                session.journal.as_ref().unwrap().state(),
                WriterState::NeedsCheck
            );
        }
        let count = host.calls.lock().unwrap().len();
        service.close().await.unwrap();
        drop(service);
        let restored = AgentService::open(host.clone(), root.path().into())
            .await
            .unwrap();
        restored.set_tools(registrations()).unwrap();
        let view = restored
            .read_session(ReadSessionRequest {
                session_id: id.to_string(),
                include_runs: true,
            })
            .await
            .unwrap()
            .session
            .unwrap();
        let call = view.runs[0]
            .items
            .iter()
            .find_map(|item| match &item.content {
                Some(agent_item::Content::ToolCall(call)) => Some(call),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            call.status,
            AgentToolStatus::Cancelled as i32,
            "after={after}"
        );
        assert_eq!(host.calls.lock().unwrap().len(), count);
        {
            let state = restored.state().unwrap();
            let journal = state.sessions[&id].journal.as_ref().unwrap();
            domain::validate_history(journal.entries()).unwrap();
            let recovery = inspect_recovery(journal.entries()).unwrap();
            assert!(recovery.gens.is_empty());
            assert!(recovery.tools.is_empty());
        }
        restored.close().await.unwrap();
    }
}

#[tokio::test]
async fn stop_ends_the_auxiliary_generation_before_cancelling_its_tool() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let id = start(&service).await;
    wait(|| host.pending.lock().unwrap().len() == 1).await;
    host.pending.lock().unwrap()[0]
        .send(GenerationEvent::Finished(message(true)))
        .unwrap();
    wait(|| host.pending.lock().unwrap().len() == 2).await;
    let run_id = service.state().unwrap().sessions[&id]
        .active
        .as_ref()
        .unwrap()
        .run_id;
    service
        .interrupt_run(InterruptRunRequest {
            session_id: id.to_string(),
            run_id: run_id.to_string(),
        })
        .unwrap();
    wait(|| service.state().unwrap().sessions[&id].active.is_none()).await;
    {
        let state = service.state().unwrap();
        let entries = state.sessions[&id].journal.as_ref().unwrap().entries();
        domain::validate_history(entries).unwrap();
        let ended = entries
            .iter()
            .rposition(|entry| {
                matches!(&entry.payload,
        domain::EntryPayload::GenEnded(end) if end.status == domain::GenStatus::Aborted)
            })
            .unwrap();
        let outcome = entries
            .iter()
            .position(|entry| match &entry.payload {
                domain::EntryPayload::ToolOutcome(outcome) => {
                    outcome.status == domain::ToolStatus::Cancelled
                }
                _ => false,
            })
            .unwrap();
        assert!(ended < outcome);
        assert_eq!(host.calls.lock().unwrap().len(), 2);
    }
    service.close().await.unwrap();
}

#[tokio::test]
async fn every_extraction_commit_prefix_recovers_without_models_or_invented_results() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let id = start(&service).await;
    wait(|| host.pending.lock().unwrap().len() == 1).await;
    host.pending.lock().unwrap()[0]
        .send(GenerationEvent::Finished(message(true)))
        .unwrap();
    wait(|| host.pending.lock().unwrap().len() == 2).await;
    host.pending.lock().unwrap()[1]
        .send(GenerationEvent::Finished(message(false)))
        .unwrap();
    wait(|| host.pending.lock().unwrap().len() == 3).await;
    host.pending.lock().unwrap()[2]
        .send(GenerationEvent::Finished(message(false)))
        .unwrap();
    wait(|| service.state().unwrap().sessions[&id].active.is_none()).await;
    let path = service.state().unwrap().sessions[&id]
        .journal
        .as_ref()
        .unwrap()
        .path()
        .to_owned();
    service.close().await.unwrap();
    drop(service);
    let raw = std::fs::read_to_string(&path).unwrap();
    let entries = domain::decode_history(&raw).unwrap();
    let lines = raw.lines().collect::<Vec<_>>();
    let intent = entries
        .iter()
        .position(|entry| matches!(entry.payload, domain::EntryPayload::ToolIntent(_)))
        .unwrap();
    let outcome = entries
        .iter()
        .position(|entry| matches!(entry.payload, domain::EntryPayload::ToolOutcome(_)))
        .unwrap();
    for installed in [true, false] {
        for count in (intent + 1)..=(outcome + 1) {
            let prefix_root = tempfile::tempdir().unwrap();
            let copy = prefix_root
                .path()
                .join(path.strip_prefix(root.path()).unwrap());
            std::fs::create_dir_all(copy.parent().unwrap()).unwrap();
            std::fs::write(&copy, format!("{}\n", lines[..count].join("\n"))).unwrap();
            let store = xw_agent_rollout::RolloutStore::new(prefix_root.path());
            let (mut journal, _) = store.open(id).unwrap();
            let tools = if installed { registrations() } else { vec![] };
            let recovered =
                crate::recovery::settle_with_tools(&mut journal, None, 1000, &tools).unwrap();
            domain::validate_history(journal.entries()).unwrap();
            assert!(recovered.gens.is_empty());
            assert!(recovered.runs.is_empty());
            assert_eq!(recovered.tools.is_empty(), installed || count > outcome);
            let result = journal
                .entries()
                .iter()
                .find_map(|entry| match &entry.payload {
                    domain::EntryPayload::ToolOutcome(result) => Some(result),
                    _ => None,
                });
            if count > outcome {
                assert_eq!(result.unwrap().status, domain::ToolStatus::Completed);
            } else if installed {
                let result = result.unwrap();
                assert_eq!(result.status, domain::ToolStatus::Cancelled);
                assert_eq!(result.metadata_json, None);
            } else {
                assert!(result.is_none());
            }
        }
    }
    assert_eq!(host.calls.lock().unwrap().len(), 3);
}

fn queue_source() -> InputSource {
    InputSource {
        kind: SourceKind::Internal,
        principal_id: "fixture".into(),
    }
}

fn queue_request(
    session: domain::SessionId,
    input: domain::InputId,
    text: &str,
) -> QueueInputRequest {
    QueueInputRequest {
        session_id: session.to_string(),
        input_id: input.to_string(),
        input: vec![AgentUserInput {
            content: Some(agent_user_input::Content::Text(text.into())),
        }],
    }
}

#[tokio::test]
async fn queued_inputs_run_in_fifo_order_and_restore_edited_input() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let session = start(&service).await;
    wait(|| host.pending.lock().unwrap().len() == 1).await;
    let first = domain::InputId::new();
    let second = domain::InputId::new();
    let request = queue_request(session, first, "first");
    service
        .queue_input(request.clone(), queue_source())
        .await
        .unwrap();
    service.queue_input(request, queue_source()).await.unwrap();
    service
        .queue_input(queue_request(session, second, "second"), queue_source())
        .await
        .unwrap();
    service
        .edit_queued_input(
            EditQueuedInputRequest {
                session_id: session.to_string(),
                input_id: second.to_string(),
                input: queue_request(session, second, "edited").input,
            },
            queue_source(),
        )
        .await
        .unwrap();
    host.pending.lock().unwrap()[0]
        .send(GenerationEvent::Finished(message(false)))
        .unwrap();
    wait(|| host.pending.lock().unwrap().len() >= 2).await;
    {
        let state = service.state().unwrap();
        let current = &state.sessions[&session];
        assert_eq!(current.view.runs.len(), 2);
        assert_eq!(current.view.runs[1].input_id, first.to_string());
        assert_eq!(current.view.queued_inputs.len(), 1);
    }
    host.pending.lock().unwrap()[1]
        .send(GenerationEvent::Finished(message(false)))
        .unwrap();
    wait(|| host.pending.lock().unwrap().len() >= 3).await;
    {
        let state = service.state().unwrap();
        let current = &state.sessions[&session];
        assert_eq!(current.view.runs[2].input_id, second.to_string());
        assert!(current.view.queued_inputs.is_empty());
        let Some(agent_item::Content::UserMessage(user)) = &current.view.runs[2].items[0].content
        else {
            panic!()
        };
        assert_eq!(user.input_id.as_deref(), Some(second.to_string().as_str()));
        assert_eq!(
            user.content[0].content,
            Some(agent_user_input::Content::Text("edited".into()))
        );
    }
    host.pending.lock().unwrap()[2]
        .send(GenerationEvent::Finished(message(false)))
        .unwrap();
    wait(|| service.state().unwrap().sessions[&session].active.is_none()).await;
    service.close().await.unwrap();
    drop(service);
    let reopened = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let snapshot = reopened
        .read_session(ReadSessionRequest {
            session_id: session.to_string(),
            include_runs: true,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    assert_eq!(snapshot.runs.len(), 3);
    assert_eq!(snapshot.runs[2].input_id, second.to_string());
}

#[tokio::test]
async fn steering_without_tool_boundary_becomes_follow_up_and_interrupt_starts_new_run() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let session = start(&service).await;
    wait(|| host.pending.lock().unwrap().len() == 1).await;
    let first = domain::InputId::new();
    service
        .queue_input(queue_request(session, first, "steer"), queue_source())
        .await
        .unwrap();
    let run = service.state().unwrap().sessions[&session]
        .active
        .as_ref()
        .unwrap()
        .run_id;
    service
        .steer_input(QueuedInputActionRequest {
            session_id: session.to_string(),
            input_id: first.to_string(),
            run_id: Some(run.to_string()),
        })
        .await
        .unwrap();
    host.pending.lock().unwrap()[0]
        .send(GenerationEvent::Finished(message(false)))
        .unwrap();
    wait(|| host.pending.lock().unwrap().len() >= 2).await;
    assert_eq!(
        service.state().unwrap().sessions[&session].view.runs[1].input_id,
        first.to_string()
    );
    let next = domain::InputId::new();
    service
        .queue_input(queue_request(session, next, "interrupt"), queue_source())
        .await
        .unwrap();
    let run = service.state().unwrap().sessions[&session]
        .active
        .as_ref()
        .unwrap()
        .run_id;
    service
        .interrupt_input(QueuedInputActionRequest {
            session_id: session.to_string(),
            input_id: next.to_string(),
            run_id: Some(run.to_string()),
        })
        .await
        .unwrap();
    wait(|| host.pending.lock().unwrap().len() >= 3).await;
    let state = service.state().unwrap();
    let current = &state.sessions[&session];
    assert_eq!(
        current.view.runs[1].status,
        AgentRunStatus::Interrupted as i32
    );
    assert_eq!(current.view.runs[2].input_id, next.to_string());
}

#[tokio::test]
async fn steering_is_inserted_between_tools_in_the_same_run_and_restored() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let session = start(&service).await;
    wait(|| host.pending.lock().unwrap().len() == 1).await;
    let input_id = domain::InputId::new();
    service
        .queue_input(
            queue_request(session, input_id, "change approach"),
            queue_source(),
        )
        .await
        .unwrap();
    let run_id = service.state().unwrap().sessions[&session]
        .active
        .as_ref()
        .unwrap()
        .run_id;
    service
        .steer_input(QueuedInputActionRequest {
            session_id: session.to_string(),
            input_id: input_id.to_string(),
            run_id: Some(run_id.to_string()),
        })
        .await
        .unwrap();
    host.pending.lock().unwrap()[0]
        .send(GenerationEvent::Finished(message(true)))
        .unwrap();
    wait(|| host.pending.lock().unwrap().len() >= 2).await;
    {
        let state = service.state().unwrap();
        let session = &state.sessions[&session];
        assert_eq!(session.view.runs.len(), 1);
        assert!(session.queue.is_empty());
        let run = &session.view.runs[0];
        assert_eq!(run.run_id, run_id.to_string());
        let input_text = input_id.to_string();
        assert!(run.items.iter().any(|item| matches!(
            &item.content,
            Some(agent_item::Content::UserMessage(user))
                if user.input_id.as_deref() == Some(input_text.as_str())
        )));
        assert!(run.items.iter().any(|item| matches!(
            &item.content,
            Some(agent_item::Content::ToolCall(tool))
                if tool.status == AgentToolStatus::Skipped as i32
        )));
    }
    host.pending.lock().unwrap()[1]
        .send(GenerationEvent::Finished(message(false)))
        .unwrap();
    wait(|| service.state().unwrap().sessions[&session].active.is_none()).await;
    service.close().await.unwrap();
    drop(service);
    let reopened = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let snapshot = reopened
        .read_session(ReadSessionRequest {
            session_id: session.to_string(),
            include_runs: true,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    assert_eq!(snapshot.runs.len(), 1);
    let input_text = input_id.to_string();
    assert!(snapshot.runs[0].items.iter().any(|item| matches!(
        &item.content,
        Some(agent_item::Content::UserMessage(user))
            if user.input_id.as_deref() == Some(input_text.as_str())
    )));
}

#[tokio::test]
async fn pending_inputs_survive_close_and_are_not_automatically_replayed() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let session = start(&service).await;
    wait(|| host.pending.lock().unwrap().len() == 1).await;
    let input_id = domain::InputId::new();
    service
        .queue_input(queue_request(session, input_id, "pending"), queue_source())
        .await
        .unwrap();
    let run_id = service.state().unwrap().sessions[&session]
        .active
        .as_ref()
        .unwrap()
        .run_id;
    service
        .steer_input(QueuedInputActionRequest {
            session_id: session.to_string(),
            input_id: input_id.to_string(),
            run_id: Some(run_id.to_string()),
        })
        .await
        .unwrap();
    service.close().await.unwrap();
    drop(service);
    let reopened = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let snapshot = reopened
        .read_session(ReadSessionRequest {
            session_id: session.to_string(),
            include_runs: true,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    assert_eq!(snapshot.queued_inputs.len(), 1);
    assert_eq!(snapshot.queued_inputs[0].input_id, input_id.to_string());
    assert_eq!(
        snapshot.queued_inputs[0].mode,
        QueuedInputMode::FollowUp as i32
    );
    assert_eq!(host.pending.lock().unwrap().len(), 1);
    reopened
        .interrupt_input(QueuedInputActionRequest {
            session_id: session.to_string(),
            input_id: input_id.to_string(),
            run_id: None,
        })
        .await
        .unwrap();
    wait(|| host.pending.lock().unwrap().len() == 2).await;
    let state = reopened.state().unwrap();
    let current = &state.sessions[&session];
    assert_eq!(current.view.runs.len(), 2);
    assert_eq!(current.view.runs[1].input_id, input_id.to_string());
    assert!(current.queue.is_empty());
}

#[tokio::test]
async fn interrupt_selects_non_head_and_keeps_other_inputs_in_fifo_order() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let session = start(&service).await;
    wait(|| host.pending.lock().unwrap().len() == 1).await;
    let first = domain::InputId::new();
    let selected = domain::InputId::new();
    let last = domain::InputId::new();
    for (id, text) in [(first, "first"), (selected, "interrupt"), (last, "last")] {
        service
            .queue_input(queue_request(session, id, text), queue_source())
            .await
            .unwrap();
    }
    let run_id = service.state().unwrap().sessions[&session]
        .active
        .as_ref()
        .unwrap()
        .run_id;
    service
        .interrupt_input(QueuedInputActionRequest {
            session_id: session.to_string(),
            input_id: selected.to_string(),
            run_id: Some(run_id.to_string()),
        })
        .await
        .unwrap();
    wait(|| host.pending.lock().unwrap().len() >= 2).await;
    {
        let state = service.state().unwrap();
        let current = &state.sessions[&session];
        assert_eq!(current.view.runs[1].input_id, selected.to_string());
        assert_eq!(
            current
                .queue
                .iter()
                .map(|entry| entry.accepted.input_id)
                .collect::<Vec<_>>(),
            vec![first, last]
        );
    }
    host.pending.lock().unwrap()[1]
        .send(GenerationEvent::Finished(message(false)))
        .unwrap();
    wait(|| host.pending.lock().unwrap().len() >= 3).await;
    assert_eq!(
        service.state().unwrap().sessions[&session].view.runs[2].input_id,
        first.to_string()
    );
}

#[tokio::test]
async fn queue_write_failure_cancels_the_run_and_never_starts_a_queued_input() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let session = start(&service).await;
    wait(|| host.pending.lock().unwrap().len() == 1).await;
    service
        .state()
        .unwrap()
        .sessions
        .get_mut(&session)
        .unwrap()
        .journal
        .as_mut()
        .unwrap()
        .fail_next_append(TestFault::Partial);
    let result = service
        .queue_input(
            queue_request(session, domain::InputId::new(), "pending"),
            queue_source(),
        )
        .await;
    assert_eq!(result.unwrap_err(), AgentError::Persistence);
    wait(|| service.state().unwrap().sessions[&session].active.is_none()).await;
    let state = service.state().unwrap();
    let current = &state.sessions[&session];
    assert!(current.failed_run.is_some());
    assert!(current.queue.is_empty());
    assert_eq!(host.pending.lock().unwrap().len(), 1);
}
