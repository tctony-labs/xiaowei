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
