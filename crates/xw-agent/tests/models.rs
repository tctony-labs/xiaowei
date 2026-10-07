use futures_util::FutureExt;
use std::sync::{Arc, Mutex};

use futures_util::{StreamExt, stream};
use xw_agent::{
    AgentHost, AgentService, AuxiliaryModelRefFuture, CancellationToken, GenerationEvent, GenerationFuture,
    GenerationRequest, GenerationStream, ModelInfo, ModelInfoError, ModelInfoFuture, protocol::*,
};
use xw_agent_types::*;

#[derive(Default)]
struct Host {
    fail_info: Mutex<bool>,
    requests: Mutex<Vec<GenerationRequest>>,
}

impl AgentHost for Host {
    fn get_model_info(&self, model_ref: String) -> ModelInfoFuture {
        let fail = *self.fail_info.lock().unwrap();
        Box::pin(async move {
            if fail {
                return Err(ModelInfoError::NotFound);
            }
            Ok(ModelInfo {
                model_ref: model_ref.clone(),
                provider_name: "tctony".into(),
                model_name: model_ref,
                capabilities: ModelCapabilities {
                    input_modalities: vec![InputModality::Text],
                    supports_reasoning: true,
                    context_window: 256_000,
                    max_output_tokens: 32_768,
                },
            })
        })
    }

    fn get_auxiliary_model_ref(&self) -> AuxiliaryModelRefFuture {
        Box::pin(async { Ok(None) })
    }

    fn generate(&self, request: GenerationRequest, _: CancellationToken) -> GenerationFuture {
        let hold = request.messages.last().is_some_and(|message| match message {
            xw_agent_types::AgentMessage::User(user) => {
                matches!(&user.content[0], ContentBlock::Text { text, .. } if text == "hold")
            }
            _ => false,
        });
        self.requests.lock().unwrap().push(request);
        Box::pin(async move {
            let sse = GenerationEvent::FirstSseReceived { received_at_ms: 1001 };
            let finished = GenerationEvent::Finished(AssistantMessage {
                content: vec![ContentBlock::Text {
                    text: "answer".into(),
                    signature: Some("signed".into()),
                }],
                api: "test".into(),
                provider: "test".into(),
                model_id: "model".into(),
                timestamp_ms: 1002,
                usage: Some(TokenUsage {
                    input: 1,
                    output: 1,
                    cache_read: 0,
                    cache_write: 0,
                    total: 2,
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
                stop_reason: FinishReason::Stop,
                response_id: None,
                response_model: None,
                provider_thinking_level: None,
                raw_stop_reason: None,
                end_turn: None,
            });
            let result: GenerationStream = if hold {
                Box::pin(stream::once(async { Ok(sse) }).chain(stream::pending()))
            } else {
                Box::pin(stream::iter([Ok(sse), Ok(finished)]))
            };
            Ok(result)
        })
    }
}

fn create(service: &AgentService) -> xw_agent::protocol::AgentSession {
    service
        .create_session(CreateSessionRequest {
            client_request_id: ClientRequestId::new().to_string(),
            config: Some(AgentModelConfig {
                model_ref: "sol".into(),
                reasoning: Some("high".into()),
            }),
            ..Default::default()
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap()
        .session
        .unwrap()
}

fn read(service: &AgentService, id: &str) -> xw_agent::protocol::AgentSession {
    service
        .read_session(ReadSessionRequest {
            session_id: id.into(),
            include_runs: true,
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap()
        .session
        .unwrap()
}

async fn send(service: &AgentService, id: &str, text: &str) -> StartRunRequest {
    let request = StartRunRequest {
        session_id: id.into(),
        input_id: InputId::new().to_string(),
        input: vec![AgentUserInput {
            content: Some(agent_user_input::Content::Text(text.into())),
        }],
        ..Default::default()
    };
    service
        .start_run(
            request.clone(),
            InputSource {
                kind: SourceKind::Cli,
                principal_id: "cli".into(),
            },
        )
        .await
        .unwrap();
    request
}

async fn idle(service: &AgentService, id: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while read(service, id).status == i32::from(AgentSessionStatus::Running) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn creation_persists_header_then_resolved_meta_and_lookup_failure_keeps_the_selection() {
    for fail_info in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let host = Arc::new(Host::default());
        *host.fail_info.lock().unwrap() = fail_info;
        let service = AgentService::with_rollout(host, directory.path().into()).unwrap();
        let session = create(&service);
        assert_eq!(session.model_info_warning.is_some(), fail_info);
        assert_eq!(session.provider_name, if fail_info { "" } else { "tctony" });
        assert_eq!(session.model_name, if fail_info { "" } else { "sol" });
        send(&service, &session.session_id, "hello").await;
        idle(&service, &session.session_id).await;
        service.close().await.unwrap();

        let store = xw_agent_rollout::RolloutStore::new(directory.path());
        let (journal, repair) = store.open(session.session_id.parse().unwrap()).unwrap();
        assert_eq!(repair.discarded_bytes, 0);
        assert!(matches!(journal.entries()[0].payload, EntryPayload::SessionHeader));
        assert_eq!(journal.entries()[0].timestamp_ms, session.created_at_ms);
        let EntryPayload::Meta(meta) = &journal.entries()[1].payload else {
            panic!("initial Meta must follow the header");
        };
        assert_eq!(meta.model_ref.as_deref(), Some("sol"));
        assert_eq!(meta.reasoning.as_deref(), Some("high"));
        assert_eq!(meta.provider_name.as_deref(), (!fail_info).then_some("tctony"));
        assert_eq!(meta.model_name.as_deref(), (!fail_info).then_some("sol"));
        assert_eq!(
            journal
                .entries()
                .iter()
                .filter(|entry| matches!(entry.payload, EntryPayload::Meta(_)))
                .count(),
            1
        );
        let text = std::fs::read_to_string(journal.path()).unwrap();
        let meta: serde_json::Value = serde_json::from_str(text.lines().nth(1).unwrap()).unwrap();
        assert!(meta["payload"]["data"].get("created_at_ms").is_none());
        if fail_info {
            assert!(meta["payload"]["data"].get("provider_name").is_none());
            assert!(meta["payload"]["data"].get("model_name").is_none());
        }
    }
}

#[tokio::test]
async fn lookup_failure_is_observed_and_original_selection_still_generates() {
    let host = Arc::new(Host::default());
    *host.fail_info.lock().unwrap() = true;
    let service = AgentService::new(host.clone());
    let session = create(&service);
    let mut first = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    let mut second = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    first.recv().await.unwrap().unwrap();
    second.recv().await.unwrap().unwrap();
    send(&service, &session.session_id, "hello").await;
    idle(&service, &session.session_id).await;
    let view = read(&service, &session.session_id);
    assert_eq!(view.metadata_revision, 1);
    assert_eq!(
        view.model_info_warning.unwrap().code,
        i32::from(ModelInfoWarningCode::NotFound)
    );
    assert_eq!(host.requests.lock().unwrap()[0].model_ref, "sol");
    assert_eq!(host.requests.lock().unwrap()[0].reasoning.as_deref(), Some("high"));
    for observer in [&mut first, &mut second] {
        loop {
            let event = observer.recv().await.unwrap().unwrap();
            if let Some(agent_event::Payload::SessionModelInfoWarningUpdated(update)) = event.payload {
                assert!(update.warning.is_some());
                break;
            }
        }
    }
    *host.fail_info.lock().unwrap() = false;
    send(&service, &session.session_id, "retry-info").await;
    idle(&service, &session.session_id).await;
    assert!(read(&service, &session.session_id).model_info_warning.is_none());
    service.close().await.unwrap();
}

#[tokio::test]
async fn committed_composer_selection_survives_reopen_and_running_snapshot_is_immutable() {
    let directory = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = AgentService::with_rollout(host.clone(), directory.path().into()).unwrap();
    let session = create(&service);
    let mut first = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    let mut second = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    first.recv().await.unwrap().unwrap();
    second.recv().await.unwrap().unwrap();
    send(&service, &session.session_id, "hold").await;
    while host.requests.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    let active = read(&service, &session.session_id).runs[0].clone();
    let revision = read(&service, &session.session_id).metadata_revision;
    service
        .set_session_config(SetSessionConfigRequest {
            session_id: session.session_id.clone(),
            expected_metadata_revision: revision,
            config: Some(AgentModelConfig {
                model_ref: "luna".into(),
                reasoning: None,
            }),
        })
        .await
        .unwrap();
    for observer in [&mut first, &mut second] {
        loop {
            let event = observer.recv().await.unwrap().unwrap();
            if let Some(agent_event::Payload::SessionConfigUpdated(update)) = event.payload {
                assert_eq!(update.config.unwrap().model_ref, "luna");
                break;
            }
        }
    }
    let view = read(&service, &session.session_id);
    assert_eq!(view.config.unwrap().model_ref, "luna");
    assert_eq!(view.runs[0].config.as_ref().unwrap().model_ref, "sol");
    service
        .interrupt_run(InterruptRunRequest {
            session_id: session.session_id.clone(),
            run_id: active.run_id,
        })
        .unwrap();
    idle(&service, &session.session_id).await;
    let request = send(&service, &session.session_id, "next").await;
    idle(&service, &session.session_id).await;
    service.close().await.unwrap();
    drop(service);
    let restored = AgentService::with_rollout(host.clone(), directory.path().into()).unwrap();
    let view = read(&restored, &session.session_id);
    assert_eq!(view.config.unwrap().model_ref, "luna");
    assert_eq!(view.provider_name, "tctony");
    assert_eq!(view.runs.len(), 2);
    let retried = restored
        .start_run(
            request,
            InputSource {
                kind: SourceKind::Cli,
                principal_id: "cli".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(retried.run.unwrap().run_id, view.runs[1].run_id);
    assert_eq!(host.requests.lock().unwrap().len(), 2);
    let store = xw_agent_rollout::RolloutStore::new(directory.path());
    restored.close().await.unwrap();
    drop(restored);
    let (journal, _) = store.open(session.session_id.parse().unwrap()).unwrap();
    assert!(journal.entries().iter().any(|entry| matches!(
        entry.payload,
        EntryPayload::GenFirstSseReceived(GenFirstSseReceived {
            received_at_ms: 1001,
            ..
        })
    )));
    validate_history(journal.entries()).unwrap();
}

struct DeferredInfoHost {
    queries:
        tokio::sync::mpsc::UnboundedSender<(String, tokio::sync::oneshot::Sender<Result<ModelInfo, ModelInfoError>>)>,
}

impl AgentHost for DeferredInfoHost {
    fn get_model_info(&self, model_ref: String) -> ModelInfoFuture {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.queries.send((model_ref, tx)).unwrap();
        Box::pin(async { rx.await.unwrap() })
    }

    fn get_auxiliary_model_ref(&self) -> AuxiliaryModelRefFuture {
        Box::pin(async { Ok(None) })
    }

    fn generate(&self, _: GenerationRequest, _: CancellationToken) -> GenerationFuture {
        panic!("query tests must not generate")
    }
}

#[tokio::test]
async fn delayed_old_lookup_cannot_overwrite_the_committed_selection_or_its_warning() {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let service = Arc::new(AgentService::new(Arc::new(DeferredInfoHost { queries: tx })));
    let creating_service = service.clone();
    let creating = tokio::spawn(async move {
        creating_service
            .create_session(CreateSessionRequest {
                client_request_id: ClientRequestId::new().to_string(),
                config: Some(AgentModelConfig {
                    model_ref: "sol".into(),
                    reasoning: Some("high".into()),
                }),
                ..Default::default()
            })
            .await
    });
    let (_, initial) = rx.recv().await.unwrap();
    initial.send(Err(ModelInfoError::Unavailable)).unwrap();
    let session = creating.await.unwrap().unwrap().session.unwrap();
    let mut observer = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .await
        .unwrap();
    observer.recv().await.unwrap().unwrap();
    let (old_ref, old) = rx.recv().await.unwrap();
    assert_eq!(old_ref, "sol");
    let update_service = service.clone();
    let id = session.session_id.clone();
    let update = tokio::spawn(async move {
        update_service
            .set_session_config(SetSessionConfigRequest {
                session_id: id,
                expected_metadata_revision: 1,
                config: Some(AgentModelConfig {
                    model_ref: "luna".into(),
                    reasoning: None,
                }),
            })
            .await
    });
    let (new_ref, new) = rx.recv().await.unwrap();
    assert_eq!(new_ref, "luna");
    new.send(Err(ModelInfoError::NotFound)).unwrap();
    update.await.unwrap().unwrap();
    old.send(Ok(ModelInfo {
        model_ref: "sol".into(),
        provider_name: "stale".into(),
        model_name: "stale".into(),
        capabilities: ModelCapabilities {
            input_modalities: vec![InputModality::Text],
            supports_reasoning: true,
            context_window: 256_000,
            max_output_tokens: 32_768,
        },
    }))
    .unwrap();
    // Allow the ready refresh task to finish its synchronous apply step.
    tokio::task::yield_now().await;
    let view = read(&service, &session.session_id);
    assert_eq!(view.config.unwrap().model_ref, "luna");
    assert_eq!(view.model_info_warning.unwrap().model_ref, "luna");
    assert!(view.provider_name.is_empty());
    assert_eq!(view.metadata_revision, 2);
    service.close().await.unwrap();
}
