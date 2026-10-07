use futures_util::FutureExt;
use std::sync::{Arc, Mutex};

use futures_util::stream;
use xw_agent_rollout::{TestFault, WriterState};
use xw_agent_types as domain;

use crate::{
    AgentError, AgentHost, AgentService, AuxiliaryModelRefFuture, CancellationToken, GenerationEvent, GenerationFuture,
    GenerationRequest, GenerationStream, InputSource, ModelInfoFuture, SourceKind, protocol::*,
};

#[derive(Default)]
struct Host {
    calls: Mutex<Vec<GenerationRequest>>,
    pending: Mutex<Option<tokio::sync::mpsc::UnboundedSender<GenerationEvent>>>,
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
            let events = stream::unfold(rx, |mut rx| async { rx.recv().await.map(|event| (Ok(event), rx)) });
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

async fn send(service: &AgentService, request: StartRunRequest) -> Result<StartRunResponse, AgentError> {
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
            .fail_append_after(1, TestFault::Partial);
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
    assert_eq!(host.calls.lock().unwrap()[0].messages.len(), 1);
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
        .send(GenerationEvent::FirstSseReceived { received_at_ms: 1000 })
        .unwrap();
    idle(&service, id).await;
    {
        let state = service.state().unwrap();
        let session = &state.sessions[&id];
        assert_eq!(session.view.runs[0].status, i32::from(AgentRunStatus::Failed));
        assert_eq!(session.journal.as_ref().unwrap().state(), WriterState::NeedsCheck);
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
    assert_eq!(ends, [domain::RunStatus::Failed, domain::RunStatus::Aborted]);
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
