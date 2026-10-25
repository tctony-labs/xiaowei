use futures_util::FutureExt;
use std::sync::{Arc, Mutex};

use futures_util::stream;
use xw_agent_rollout::{TestFault, WriterState};
use xw_agent_types as domain;

use crate::{
    AgentError, AgentHost, AgentService, AuxiliaryModelRefFuture, CancellationToken,
    GenerationEvent, GenerationFuture, GenerationRequest, GenerationStream, InputSource,
    ModelInfoFuture, SourceKind, protocol::*,
};

#[derive(Default)]
struct Host {
    calls: Mutex<Vec<GenerationRequest>>,
    pending: Mutex<Option<tokio::sync::mpsc::UnboundedSender<GenerationEvent>>>,
}

#[tokio::test]
async fn failed_tool_result_commit_never_generates_again_or_replays_the_write() {
    failed_tool_commit(
        "Write",
        r#"{"path":"committed-side-effect","contents":"once"}"#,
        3,
        true,
    )
    .await;
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn failed_bash_intent_and_result_commits_never_replay_side_effects() {
    for (after, executed) in [(2, false), (3, true)] {
        failed_tool_commit(
            "Bash",
            concat!(
                r#"{"description":"commit failure test","#,
                r#""command":"printf once > committed-side-effect"}"#,
            ),
            after,
            executed,
        )
        .await;
    }
}

async fn failed_tool_commit(name: &str, arguments: &str, after: usize, executed: bool) {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = AgentService::with_rollout(host.clone(), root.path().into()).unwrap();
    let session = service
        .create_session(CreateSessionRequest {
            client_request_id: domain::ClientRequestId::new().to_string(),
            config: Some(AgentModelConfig {
                model_ref: "test".into(),
                reasoning: None,
            }),
            ..Default::default()
        })
        .await
        .unwrap()
        .session
        .unwrap();
    let id: domain::SessionId = session.session_id.parse().unwrap();
    send(&service, request(&session.session_id)).await.unwrap();
    while host.pending.lock().unwrap().is_none() {
        tokio::task::yield_now().await;
    }
    let fixture = domain::decode_history(include_str!("../tests/fixtures/tools.jsonl")).unwrap();
    let mut message = fixture
        .iter()
        .find_map(|entry| match &entry.payload {
            domain::EntryPayload::Message(recorded) => match &recorded.message {
                domain::AgentMessage::Assistant(message) => Some(message.clone()),
                _ => None,
            },
            _ => None,
        })
        .unwrap();
    message.stop_reason = domain::FinishReason::ToolUse;
    message.content = vec![domain::ContentBlock::ToolCall {
        id: "side-effect-call".into(),
        name: name.into(),
        arguments_json: Some(arguments.into()),
        thought_signature: None,
        namespace: None,
    }];
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
    host.pending
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .send(GenerationEvent::Finished(message))
        .unwrap();
    idle(&service, id).await;
    assert_eq!(host.calls.lock().unwrap().len(), 1);
    let file = std::path::Path::new(session.cwd.as_ref().unwrap()).join("committed-side-effect");
    if executed {
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "once");
    } else {
        assert!(!file.exists());
    }
    service.close().await.unwrap();
    std::fs::write(&file, "sentinel").unwrap();
    let service = AgentService::with_rollout(host.clone(), root.path().into()).unwrap();
    assert!(matches!(
        send(&service, request(&session.session_id)).await,
        Err(AgentError::Conflict(_))
    ));
    assert_eq!(host.calls.lock().unwrap().len(), 1);
    assert_eq!(std::fs::read_to_string(file).unwrap(), "sentinel");
    service.close().await.unwrap();
}

impl AgentHost for Host {
    fn get_model_info(&self, _: String) -> ModelInfoFuture {
        Box::pin(async { Err(crate::ModelInfoError::Unavailable) })
    }

    fn get_auxiliary_model_ref(&self) -> AuxiliaryModelRefFuture {
        Box::pin(async { Ok(None) })
    }

    fn generate(&self, request: GenerationRequest, _: CancellationToken) -> GenerationFuture {
        self.calls.lock().unwrap().push(request);
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        *self.pending.lock().unwrap() = Some(tx);
        Box::pin(async move {
            let events = stream::unfold(rx, |mut rx| async {
                rx.recv().await.map(|event| (Ok(event), rx))
            });
            Ok(Box::pin(events) as GenerationStream)
        })
    }
}

fn request(id: &str) -> StartRunRequest {
    StartRunRequest {
        session_id: id.into(),
        input_id: domain::InputId::new().to_string(),
        input: vec![AgentUserInput {
            content: Some(agent_user_input::Content::Text("query".into())),
        }],
        ..Default::default()
    }
}

async fn send(
    service: &AgentService,
    request: StartRunRequest,
) -> Result<StartRunResponse, AgentError> {
    service
        .start_run(
            request,
            InputSource {
                kind: SourceKind::Cli,
                principal_id: "test".into(),
            },
        )
        .await
}

async fn idle(service: &AgentService, id: domain::SessionId) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while service.state().unwrap().sessions[&id].active.is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn failed_acceptance_reserves_input_and_next_query_repairs_without_executing_it() {
    let directory = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = AgentService::with_rollout(host.clone(), directory.path().into()).unwrap();
    let session = service
        .create_session(CreateSessionRequest {
            cwd: None,
            client_request_id: domain::ClientRequestId::new().to_string(),
            config: Some(AgentModelConfig {
                model_ref: "original".into(),
                reasoning: Some("high".into()),
            }),
            ..Default::default()
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap()
        .session
        .unwrap();
    let id: domain::SessionId = session.session_id.parse().unwrap();
    let original = request(&session.session_id);
    {
        let mut state = service.state().unwrap();
        state
            .sessions
            .get_mut(&id)
            .unwrap()
            .journal
            .as_mut()
            .unwrap()
            .fail_append_after(2, TestFault::Partial);
    }
    assert!(matches!(
        send(&service, original.clone()).await,
        Err(AgentError::Persistence)
    ));
    assert!(host.calls.lock().unwrap().is_empty());
    // InputAccepted committed; the failed RunStarted tail is discarded.
    assert!(matches!(
        send(&service, original.clone()).await,
        Err(AgentError::Conflict(_))
    ));
    assert!(host.calls.lock().unwrap().is_empty());
    let mut mismatched = original;
    mismatched.input[0].content = Some(agent_user_input::Content::Text("different".into()));
    assert!(matches!(
        send(&service, mismatched).await,
        Err(AgentError::Conflict("input identity"))
    ));
    send(&service, request(&session.session_id)).await.unwrap();
    while host.calls.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    assert_eq!(host.calls.lock().unwrap()[0].messages.len(), 2);
    // A required in-flight append failure fails the whole Run and cancels generation.
    {
        let mut state = service.state().unwrap();
        state
            .sessions
            .get_mut(&id)
            .unwrap()
            .journal
            .as_mut()
            .unwrap()
            .fail_next_append(TestFault::Sync);
    }
    host.pending
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .send(GenerationEvent::FirstSseReceived {
            received_at_ms: 1000,
        })
        .unwrap();
    idle(&service, id).await;
    {
        let state = service.state().unwrap();
        let session = &state.sessions[&id];
        assert_eq!(
            session.view.runs[0].status,
            i32::from(AgentRunStatus::Failed)
        );
        assert_eq!(
            session.journal.as_ref().unwrap().state(),
            WriterState::NeedsCheck
        );
    }
    // If settling the old Run still cannot commit, the new query never reaches Host.
    {
        let mut state = service.state().unwrap();
        state
            .sessions
            .get_mut(&id)
            .unwrap()
            .journal
            .as_mut()
            .unwrap()
            .fail_next_append(TestFault::BeforeWrite);
    }
    assert!(matches!(
        send(&service, request(&session.session_id)).await,
        Err(AgentError::Persistence)
    ));
    assert_eq!(host.calls.lock().unwrap().len(), 1);
    send(&service, request(&session.session_id)).await.unwrap();
    while host.calls.lock().unwrap().len() < 2 {
        tokio::task::yield_now().await;
    }
    service.close().await.unwrap();
    drop(service);
    let store = xw_agent_rollout::RolloutStore::new(directory.path());
    let (journal, _) = store.open(id).unwrap();
    domain::validate_history(journal.entries()).unwrap();
    let ends = journal
        .entries()
        .iter()
        .filter_map(|entry| match &entry.payload {
            domain::EntryPayload::RunEnd(end) => Some(end.status),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        ends,
        [domain::RunStatus::Failed, domain::RunStatus::Aborted]
    );
    assert!(
        std::fs::read_dir(journal.path().parent().unwrap())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .path()
                .extension()
                .unwrap()
                .to_string_lossy()
                .starts_with("tail-"))
    );
}

#[tokio::test]
async fn a_failed_permission_decision_never_grants_or_resumes_and_recovery_closes_the_card() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = AgentService::with_rollout(host.clone(), root.path().into()).unwrap();
    let session = service
        .create_session(CreateSessionRequest {
            client_request_id: domain::ClientRequestId::new().to_string(),
            config: Some(AgentModelConfig {
                model_ref: "test".into(),
                reasoning: None,
            }),
            ..Default::default()
        })
        .await
        .unwrap()
        .session
        .unwrap();
    let id: domain::SessionId = session.session_id.parse().unwrap();
    let mut events = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .await
        .unwrap();
    send(&service, request(&session.session_id)).await.unwrap();
    while host.pending.lock().unwrap().is_none() {
        tokio::task::yield_now().await;
    }
    let fixture = domain::decode_history(include_str!("../tests/fixtures/tools.jsonl")).unwrap();
    let mut message = fixture
        .iter()
        .find_map(|entry| match &entry.payload {
            domain::EntryPayload::Message(recorded) => match &recorded.message {
                domain::AgentMessage::Assistant(message) => Some(message.clone()),
                _ => None,
            },
            _ => None,
        })
        .unwrap();
    message.stop_reason = domain::FinishReason::ToolUse;
    message.content = vec![domain::ContentBlock::ToolCall {
        id: "permission-call".into(),
        name: "RequestPermission".into(),
        arguments_json: Some(
            serde_json::json!({
                "path": root.path().join("target"), "is_directory": false, "reason": "test",
            })
            .to_string(),
        ),
        thought_signature: None,
        namespace: None,
    }];
    host.pending
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .send(GenerationEvent::Finished(message))
        .unwrap();
    let view = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if let Some(agent_event::Payload::InteractionUpdated(update)) =
                events.recv().await.unwrap().unwrap().payload
            {
                return update.interaction.unwrap();
            }
        }
    })
    .await
    .unwrap();
    service
        .state()
        .unwrap()
        .sessions
        .get_mut(&id)
        .unwrap()
        .journal
        .as_mut()
        .unwrap()
        .fail_next_append(TestFault::Partial);
    let result = service
        .respond_interaction(
            RespondInteractionRequest {
                session_id: session.session_id.clone(),
                interaction_id: view.interaction_id,
                expected_revision: 1,
                client_request_id: domain::ClientRequestId::new().to_string(),
                answer: Some(AgentInteractionAnswer {
                    answer: Some(agent_interaction_answer::Answer::Permission(
                        AgentPermissionAnswer { allow: true },
                    )),
                }),
            },
            InputSource {
                kind: SourceKind::Desktop,
                principal_id: "desktop".into(),
            },
        )
        .await;
    assert_eq!(result.unwrap_err(), AgentError::Persistence);
    idle(&service, id).await;
    assert!(
        service.state().unwrap().sessions[&id]
            .granted_paths
            .is_empty()
    );
    assert_eq!(host.calls.lock().unwrap().len(), 1);
    {
        let mut state = service.state().unwrap();
        let session = state.sessions.get_mut(&id).unwrap();
        session.prepare_writer().unwrap();
        for item in &session.view.runs[0].items {
            if let Some(agent_item::Content::ToolCall(tool)) = &item.content {
                assert_eq!(
                    tool.interaction.as_ref().unwrap().status,
                    AgentInteractionStatus::Expired as i32
                );
            }
        }
    }
    service.close().await.unwrap();
    let restored = AgentService::with_rollout(host.clone(), root.path().into()).unwrap();
    let state = restored.state().unwrap();
    assert!(state.sessions[&id].granted_paths.is_empty());
    assert!(
        state.sessions[&id]
            .interactions
            .values()
            .all(|record| !record.pending())
    );
    assert_eq!(host.calls.lock().unwrap().len(), 1);
}
