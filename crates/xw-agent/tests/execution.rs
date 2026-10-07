use futures_util::FutureExt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{StreamExt, stream};
use xw_agent::{
    AgentError, AgentHost, AgentService, CancellationToken, GenerationEvent, GenerationFuture, GenerationRequest,
    GenerationStream, InputSource, SourceKind, protocol::*,
};
use xw_agent_types::{AgentMessage as History, AssistantMessage, ClientRequestId, ContentBlock, FinishReason, InputId};

#[derive(Default)]
struct Model {
    requests: Mutex<Vec<GenerationRequest>>,
}
impl AgentHost for Model {
    fn get_model_info(&self, model_ref: String) -> xw_agent::ModelInfoFuture {
        Box::pin(async move {
            Ok(xw_agent::ModelInfo {
                model_ref,
                provider_name: "fixture".into(),
                model_name: "test".into(),
                capabilities: xw_agent_types::ModelCapabilities {
                    input_modalities: vec![xw_agent_types::InputModality::Text],
                    supports_reasoning: true,
                    context_window: 256_000,
                    max_output_tokens: 32_768,
                },
            })
        })
    }

    fn get_auxiliary_model_ref(&self) -> xw_agent::AuxiliaryModelRefFuture {
        Box::pin(async { Ok(None) })
    }

    fn generate(&self, request: GenerationRequest, _: CancellationToken) -> GenerationFuture {
        let text = match request.messages.last().unwrap() {
            History::User(user) => match &user.content[0] {
                ContentBlock::Text { text, .. } => text.clone(),
                _ => unreachable!(),
            },
            _ => unreachable!(),
        };
        self.requests.lock().unwrap().push(request);
        Box::pin(async move {
            let partial = GenerationEvent::TextDelta {
                content_index: 0,
                text: "display only".into(),
            };
            let final_message = AssistantMessage {
                content: vec![ContentBlock::Text {
                    text: "authoritative final".into(),
                    signature: Some("signed".into()),
                }],
                api: "api".into(),
                provider: "provider".into(),
                model_id: "upstream".into(),
                usage: None,
                stop_reason: FinishReason::Stop,
                timestamp_ms: 1,
                response_id: Some("response-id".into()),
                response_model: None,
                provider_thinking_level: None,
                raw_stop_reason: None,
                end_turn: None,
            };
            if text == "hold" {
                Ok(Box::pin(stream::once(async { Ok(partial) }).chain(stream::pending())) as GenerationStream)
            } else if text == "eof" {
                Ok(Box::pin(stream::iter(vec![Ok(partial)])) as GenerationStream)
            } else {
                Ok(Box::pin(stream::iter(vec![
                    Ok(partial),
                    Ok(GenerationEvent::Finished(final_message)),
                ])) as GenerationStream)
            }
        })
    }
}
fn source(name: &str) -> InputSource {
    InputSource {
        kind: SourceKind::Cli,
        principal_id: name.into(),
    }
}
fn create(service: &AgentService) -> AgentSession {
    service
        .create_session(CreateSessionRequest {
            title_model_ref: String::new(),
            client_request_id: ClientRequestId::new().to_string(),
            config: Some(AgentModelConfig {
                model_ref: "test".into(),
                reasoning: Some("high".into()),
            }),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap()
        .session
        .unwrap()
}
fn request(session: &AgentSession, text: &str) -> StartRunRequest {
    StartRunRequest {
        title_model_ref: None,
        session_id: session.session_id.clone(),
        input_id: InputId::new().to_string(),
        input: vec![AgentUserInput {
            content: Some(agent_user_input::Content::Text(text.into())),
        }],
        config: None,
    }
}
async fn terminal(subscription: &mut xw_agent::EventSubscription) -> AgentRun {
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let event = subscription.recv().await.unwrap().unwrap();
            if let Some(agent_event::Payload::RunCompleted(done)) = event.payload {
                return done.run.unwrap();
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn two_callers_share_runs_final_history_config_and_idempotency() {
    let model = Arc::new(Model::default());
    let service = AgentService::new(model.clone());
    let session = create(&service);
    let mut a = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    let mut b = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    let first = request(&session, "first");
    let accepted = service.start_run(first.clone(), source("a")).await.unwrap();
    assert_eq!(service.start_run(first.clone(), source("a")).await.unwrap(), accepted);
    assert!(matches!(
        service.start_run(request(&session, "conflicting"), source("b")).await,
        Err(AgentError::Conflict(_))
    ));
    let final_run = terminal(&mut a).await;
    assert_eq!(terminal(&mut b).await, final_run);
    assert_eq!(final_run.status, i32::from(AgentRunStatus::Completed));
    assert_eq!(
        service.start_run(first.clone(), source("b")).await.unwrap().run,
        Some(final_run)
    );
    let mut conflict = first;
    conflict.input[0].content = Some(agent_user_input::Content::Text("different".into()));
    assert!(matches!(
        service.start_run(conflict, source("a")).await,
        Err(AgentError::Conflict(_))
    ));
    let mut second = request(&session, "second");
    second.config = Some(AgentModelConfig {
        model_ref: "changed".into(),
        reasoning: None,
    });
    service.start_run(second, source("b")).await.unwrap();
    terminal(&mut a).await;
    terminal(&mut b).await;
    {
        let calls = model.requests.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].model_ref, "changed");
        assert!(calls[1].reasoning.is_none());
        assert_eq!(calls[1].messages.len(), 3);
        let History::Assistant(message) = &calls[1].messages[1] else {
            panic!();
        };
        assert_eq!(message.response_id.as_deref(), Some("response-id"));
        let ContentBlock::Text { text, signature } = &message.content[0] else {
            panic!("missing text");
        };
        assert_eq!(text, "authoritative final");
        assert_eq!(signature.as_deref(), Some("signed"));
    }
    let view = service
        .read_session(ReadSessionRequest {
            session_id: session.session_id,
            include_runs: true,
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap()
        .session
        .unwrap();
    assert_eq!(view.metadata_revision, 1);
    assert_eq!(view.runs.len(), 2);
    service.close().await.unwrap();
}

#[tokio::test]
async fn observer_drop_does_not_stop_run_interrupt_is_exact_partial_never_enters_history() {
    let model = Arc::new(Model::default());
    let service = AgentService::new(model.clone());
    let session = create(&service);
    let mut observer = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    let run = service
        .start_run(request(&session, "hold"), source("a"))
        .await
        .unwrap()
        .run
        .unwrap();
    loop {
        let event = observer.recv().await.unwrap().unwrap();
        if matches!(event.payload, Some(agent_event::Payload::AgentMessageDelta(_))) {
            break;
        }
    }
    drop(observer);
    assert_eq!(
        service
            .read_session(ReadSessionRequest {
                session_id: session.session_id.clone(),
                include_runs: true
            })
            .now_or_never()
            .expect("memory operation completes immediately")
            .unwrap()
            .session
            .unwrap()
            .runs[0]
            .status,
        i32::from(AgentRunStatus::InProgress)
    );
    let mut observer = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    assert!(
        !service
            .interrupt_run(InterruptRunRequest {
                session_id: session.session_id.clone(),
                run_id: xw_agent_types::RunId::new().to_string()
            })
            .unwrap()
            .cancellation_requested
    );
    assert!(
        service
            .interrupt_run(InterruptRunRequest {
                session_id: session.session_id.clone(),
                run_id: run.run_id
            })
            .unwrap()
            .cancellation_requested
    );
    let cancelled = terminal(&mut observer).await;
    assert_eq!(cancelled.status, i32::from(AgentRunStatus::Interrupted));
    assert_eq!(cancelled.items.len(), 2);
    service.start_run(request(&session, "eof"), source("b")).await.unwrap();
    assert_eq!(terminal(&mut observer).await.status, i32::from(AgentRunStatus::Failed));
    service
        .start_run(request(&session, "success"), source("b"))
        .await
        .unwrap();
    terminal(&mut observer).await;
    assert_eq!(model.requests.lock().unwrap()[2].messages.len(), 3);
    let running = service.start_run(request(&session, "hold"), source("a")).await.unwrap();
    assert!(running.run.is_some());
    service
        .delete_session(DeleteSessionRequest {
            targets: vec![DeleteSessionTarget {
                session_id: session.session_id.clone(),
                expected_metadata_revision: 1,
                expected_archive_revision: None,
            }],
        })
        .await
        .unwrap();
    assert!(
        !service
            .read_session(ReadSessionRequest {
                session_id: session.session_id,
                include_runs: true
            })
            .now_or_never()
            .expect("memory operation completes immediately")
            .unwrap()
            .found
    );
    service.close().await.unwrap();
    service.close().await.unwrap();
}

#[tokio::test]
async fn retained_idempotency_inputs_share_the_history_budget_and_rejection_does_not_mutate_config() {
    let model = Arc::new(Model::default());
    let service = AgentService::new(model.clone());
    let session = create(&service);
    let mut observer = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    let text = "x".repeat(64 * 1024);
    let mut last = None;
    let mut accepted = 0;
    loop {
        let mut input = request(&session, &text);
        input.config = Some(AgentModelConfig {
            model_ref: format!("model-{accepted}"),
            reasoning: None,
        });
        match service.start_run(input.clone(), source("a")).await {
            Ok(_) => {
                terminal(&mut observer).await;
                last = Some(input);
                accepted += 1;
                assert!(
                    accepted < 80,
                    "retained request copies must count against the 8 MiB history budget"
                );
            }
            Err(AgentError::ResourceExhausted(_)) => break,
            result => panic!("unexpected result: {result:?}"),
        }
    }
    assert!(accepted > 1);
    assert_eq!(model.requests.lock().unwrap().len(), accepted);
    let last = last.unwrap();
    assert!(
        service
            .start_run(last.clone(), source("b"))
            .await
            .unwrap()
            .run
            .is_some()
    );
    let view = service
        .read_session(ReadSessionRequest {
            session_id: session.session_id.clone(),
            include_runs: false,
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap()
        .session
        .unwrap();
    assert_eq!(view.config, session.config);
    service.close().await.unwrap();
}
