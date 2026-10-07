use futures_util::FutureExt;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::stream;
use tokio::sync::mpsc;
use xw_agent::{
    AgentError, AgentHost, AgentService, CancellationToken, GenerationEvent, GenerationFuture, GenerationRequest,
    GenerationStream, InputSource, SourceKind, protocol::*,
};
use xw_agent_types::{AgentMessage as History, AssistantMessage, ClientRequestId, ContentBlock, FinishReason, InputId};

#[derive(Default)]
struct Model {
    requests: Mutex<Vec<GenerationRequest>>,
    auxiliary: Mutex<Option<String>>,
    titles: Mutex<Vec<mpsc::Sender<Result<GenerationEvent, xw_agent::GenerationError>>>>,
    cancellations: Mutex<Vec<CancellationToken>>,
}

fn message(text: &str) -> AssistantMessage {
    AssistantMessage {
        api: "test".into(),
        provider: "test".into(),
        model_id: "test".into(),
        content: vec![ContentBlock::Text {
            text: text.into(),
            signature: Some("signature".into()),
        }],
        usage: Default::default(),
        stop_reason: FinishReason::Stop,
        timestamp_ms: 1,
        response_id: None,
        response_model: None,
        provider_thinking_level: None,
        raw_stop_reason: None,
        end_turn: None,
    }
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
        let reference = self.auxiliary.lock().unwrap().clone();
        Box::pin(async move { Ok(reference) })
    }

    fn generate(&self, request: GenerationRequest, cancellation: CancellationToken) -> GenerationFuture {
        let auxiliary = !request.system_prompt.is_empty();
        let partial = matches!(request.messages.last(), Some(History::User(user))
            if matches!(&user.content[0], ContentBlock::Text { text, .. } if text == "partial"));
        self.requests.lock().unwrap().push(request);
        let (tx, rx) = mpsc::channel(8);
        if auxiliary {
            self.titles.lock().unwrap().push(tx);
            self.cancellations.lock().unwrap().push(cancellation);
        } else {
            let event = if partial {
                GenerationEvent::TextDelta {
                    content_index: 0,
                    text: "部分正文".into(),
                }
            } else {
                GenerationEvent::Finished(message("正文"))
            };
            tx.try_send(Ok(event)).unwrap();
        }
        Box::pin(async move {
            Ok(Box::pin(stream::unfold(rx, |mut rx| async {
                rx.recv().await.map(|event| (event, rx))
            })) as GenerationStream)
        })
    }
}

fn create(service: &AgentService, host: &Model, model: &str) -> AgentSession {
    *host.auxiliary.lock().unwrap() = (!model.is_empty()).then(|| model.to_owned());
    service
        .create_session(CreateSessionRequest {
            client_request_id: ClientRequestId::new().to_string(),
            config: Some(AgentModelConfig {
                model_ref: "chat".into(),
                reasoning: Some("high".into()),
            }),
            title_model_ref: model.into(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap()
        .session
        .unwrap()
}

async fn send(service: &AgentService, session: &AgentSession) {
    send_text(service, session, "问题").await;
}

async fn send_text(service: &AgentService, session: &AgentSession, text: &str) {
    service
        .start_run(
            StartRunRequest {
                session_id: session.session_id.clone(),
                input_id: InputId::new().to_string(),
                input: vec![AgentUserInput {
                    content: Some(agent_user_input::Content::Text(text.into())),
                }],
                ..Default::default()
            },
            InputSource {
                kind: SourceKind::Cli,
                principal_id: "test".into(),
            },
        )
        .await
        .unwrap();
}

async fn wait_for(model: &Model, count: usize) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while model.requests.lock().unwrap().len() < count {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn title_event(observer: &mut xw_agent::EventSubscription) -> SessionTitleUpdated {
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let Some(agent_event::Payload::SessionTitleUpdated(title)) =
                observer.recv().await.unwrap().unwrap().payload
            {
                return title;
            }
        }
    })
    .await
    .unwrap()
}

fn read(service: &AgentService, session: &AgentSession) -> AgentSession {
    service
        .read_session(ReadSessionRequest {
            session_id: session.session_id.clone(),
            include_runs: true,
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap()
        .session
        .unwrap()
}

#[tokio::test]
async fn automatic_title_is_after_run_completion_and_shared_by_observers_and_reconnects() {
    let model = Arc::new(Model::default());
    let service = AgentService::new(model.clone());
    let session = create(&service, &model, "small");
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
    send(&service, &session).await;
    wait_for(&model, 2).await;
    assert_eq!(
        read(&service, &session).runs[0].status,
        i32::from(AgentRunStatus::Completed)
    );
    assert!(read(&service, &session).title.is_empty());
    let activity_before_title = read(&service, &session).updated_at_ms;
    tokio::time::sleep(Duration::from_millis(2)).await;
    {
        let requests = model.requests.lock().unwrap();
        let title = &requests[1];
        assert_eq!(title.model_ref, "small");
        assert_eq!(title.reasoning.as_deref(), Some("off"));
        assert_eq!(title.max_tokens, Some(64));
        assert_eq!(title.temperature, Some(0.8));
        assert_eq!(title.messages.len(), 1);
    }
    model.titles.lock().unwrap()[0]
        .try_send(Ok(GenerationEvent::Finished(message("“自动标题。”"))))
        .unwrap();
    let updated = title_event(&mut a).await;
    assert_eq!(updated.title, "自动标题");
    assert_eq!(updated.updated_at_ms, activity_before_title);
    assert_eq!(read(&service, &session).updated_at_ms, activity_before_title);
    assert_eq!(title_event(&mut b).await, updated);
    let mut reconnect = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    let Some(agent_event::Payload::SubscriptionReady(ready)) = reconnect.recv().await.unwrap().unwrap().payload else {
        panic!()
    };
    assert_eq!(ready.session.unwrap().title, "自动标题");
    send(&service, &session).await;
    wait_for(&model, 4).await;
    assert_eq!(
        model.requests.lock().unwrap()[2].messages.len(),
        3,
        "title prompt must not enter chat history"
    );
    service.close().await.unwrap();
}

#[tokio::test]
async fn manual_title_uses_latest_auxiliary_model_and_eof_keeps_previous_title() {
    let model = Arc::new(Model::default());
    let service = Arc::new(AgentService::new(model.clone()));
    let session = create(&service, &model, "");
    send(&service, &session).await;
    wait_for(&model, 1).await;
    while read(&service, &session).status != i32::from(AgentSessionStatus::Idle) {
        tokio::task::yield_now().await;
    }
    assert_eq!(model.requests.lock().unwrap().len(), 1, "no fallback auxiliary call");
    *model.auxiliary.lock().unwrap() = Some("new-small".into());
    let request = RegenerateTitleRequest {
        session_id: session.session_id.clone(),
        title_model_ref: "new-small".into(),
    };
    let task_service = service.clone();
    let task = tokio::spawn(async move { task_service.regenerate_title(request).await });
    wait_for(&model, 2).await;
    model.titles.lock().unwrap()[0]
        .try_send(Ok(GenerationEvent::Finished(message("**手动标题**"))))
        .unwrap();
    assert_eq!(task.await.unwrap().unwrap().title, "手动标题");
    assert!(read(&service, &session).title_model_ref.is_empty());
    let task_service = service.clone();
    let id = session.session_id.clone();
    let task = tokio::spawn(async move {
        task_service
            .regenerate_title(RegenerateTitleRequest {
                session_id: id,
                title_model_ref: "bad-small".into(),
            })
            .await
    });
    wait_for(&model, 3).await;
    model.titles.lock().unwrap()[1]
        .try_send(Ok(GenerationEvent::TextDelta {
            content_index: 0,
            text: "partial title".into(),
        }))
        .unwrap();
    model.titles.lock().unwrap().pop();
    assert!(matches!(task.await.unwrap(), Err(AgentError::TitleGeneration(_))));
    assert_eq!(read(&service, &session).title, "手动标题");
    assert!(read(&service, &session).title_model_ref.is_empty());
    service.close().await.unwrap();
}

#[tokio::test]
async fn new_run_delete_and_close_cancel_pending_titles_without_late_updates() {
    let model = Arc::new(Model::default());
    let service = AgentService::new(model.clone());
    let session = create(&service, &model, "small");
    send(&service, &session).await;
    wait_for(&model, 2).await;
    send(&service, &session).await;
    wait_for(&model, 4).await;
    assert!(model.cancellations.lock().unwrap()[0].is_cancelled());
    let _ = model.titles.lock().unwrap()[0].try_send(Ok(GenerationEvent::Finished(message("过期标题"))));
    let view = read(&service, &session);
    assert!(view.title.is_empty(), "cancelled title must not be committed");
    service
        .delete_session(DeleteSessionRequest {
            targets: vec![DeleteSessionTarget {
                session_id: session.session_id,
                expected_metadata_revision: view.metadata_revision,
                expected_archive_revision: None,
            }],
        })
        .await
        .unwrap();
    assert!(model.cancellations.lock().unwrap()[1].is_cancelled());
    let session = create(&service, &model, "small");
    send(&service, &session).await;
    wait_for(&model, 6).await;
    service.close().await.unwrap();
    assert!(model.cancellations.lock().unwrap()[2].is_cancelled());
}

#[tokio::test]
async fn missing_model_empty_history_and_invalid_refs_are_rejected() {
    let model = Arc::new(Model::default());
    let service = AgentService::new(model.clone());
    let session = create(&service, &model, "");
    for model in ["", "valid"] {
        assert!(matches!(
            service
                .regenerate_title(RegenerateTitleRequest {
                    session_id: session.session_id.clone(),
                    title_model_ref: model.into(),
                })
                .await,
            Err(AgentError::TitleGeneration(_))
        ));
    }
    assert!(matches!(
        service
            .regenerate_title(RegenerateTitleRequest {
                session_id: session.session_id,
                title_model_ref: " ".into(),
            })
            .await,
        Err(AgentError::TitleGeneration(_))
    ));
    service.close().await.unwrap();
}

#[tokio::test]
async fn partial_assistant_output_still_triggers_auto_title_after_a_failed_run() {
    let model = Arc::new(Model::default());
    let service = AgentService::new(model.clone());
    let session = create(&service, &model, "small");
    let mut observer = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    send_text(&service, &session, "partial").await;
    wait_for(&model, 2).await;
    assert_eq!(
        read(&service, &session).runs[0].status,
        i32::from(AgentRunStatus::Failed)
    );
    model.titles.lock().unwrap()[0]
        .try_send(Ok(GenerationEvent::Finished(message("部分回复的主题"))))
        .unwrap();
    assert_eq!(title_event(&mut observer).await.title, "部分回复的主题");
    service.close().await.unwrap();
}

#[tokio::test]
async fn setting_title_cancels_stale_generation_and_protects_future_runs_until_regenerated() {
    let model = Arc::new(Model::default());
    let service = Arc::new(AgentService::new(model.clone()));
    let session = create(&service, &model, "small");
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
    send(&service, &session).await;
    wait_for(&model, 2).await;
    let response = service
        .set_session_title(SetSessionTitleRequest {
            session_id: session.session_id.clone(),
            title: "  手写标题  ".into(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    assert_eq!(response.title, "手写标题");
    assert!(model.cancellations.lock().unwrap()[0].is_cancelled());
    let update = title_event(&mut a).await;
    assert!(!update.auto_title_enabled);
    assert_eq!(title_event(&mut b).await, update);
    let _ = model.titles.lock().unwrap()[0].try_send(Ok(GenerationEvent::Finished(message("过期自动标题"))));
    send(&service, &session).await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while read(&service, &session).runs.last().unwrap().status == i32::from(AgentRunStatus::InProgress) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        model.requests.lock().unwrap().len(),
        3,
        "manual title disables automatic generation"
    );
    assert_eq!(read(&service, &session).title, "手写标题");

    let shared = service.clone();
    let id = session.session_id.clone();
    let regeneration = tokio::spawn(async move {
        shared
            .regenerate_title(RegenerateTitleRequest {
                session_id: id,
                title_model_ref: "small".into(),
            })
            .await
    });
    wait_for(&model, 4).await;
    // Setting the same manual text still supersedes a newly pending generation.
    service
        .set_session_title(SetSessionTitleRequest {
            session_id: session.session_id.clone(),
            title: "手写标题".into(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    assert!(regeneration.await.unwrap().is_err());
    assert!(!read(&service, &session).auto_title_enabled);

    let shared = service.clone();
    let id = session.session_id.clone();
    let regeneration = tokio::spawn(async move {
        shared
            .regenerate_title(RegenerateTitleRequest {
                session_id: id,
                title_model_ref: "small".into(),
            })
            .await
    });
    wait_for(&model, 5).await;
    model
        .titles
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .try_send(Ok(GenerationEvent::Finished(message("重新生成标题"))))
        .unwrap();
    assert_eq!(regeneration.await.unwrap().unwrap().title, "重新生成标题");
    assert!(read(&service, &session).auto_title_enabled);
    send(&service, &session).await;
    wait_for(&model, 7).await;
    assert_eq!(model.requests.lock().unwrap().last().unwrap().max_tokens, Some(64));
    service.close().await.unwrap();
}

#[tokio::test]
async fn title_setting_validates_without_mutating_and_repeated_manual_titles_are_idempotent() {
    let model = Arc::new(Model::default());
    let service = AgentService::new(model.clone());
    let session = create(&service, &model, "small");
    for title in [
        " ".into(),
        "题".repeat(51),
        "line\nbreak".into(),
        "tab\there".into(),
        "bad\0title".into(),
    ] {
        assert_eq!(
            service
                .set_session_title(SetSessionTitleRequest {
                    session_id: session.session_id.clone(),
                    title,
                })
                .now_or_never()
                .expect("memory operation completes immediately"),
            Err(AgentError::InvalidArgument("title"))
        );
        assert_eq!(read(&service, &session), session);
    }
    let request = SetSessionTitleRequest {
        session_id: session.session_id.clone(),
        title: "😀".repeat(50),
    };
    let response = service
        .set_session_title(request.clone())
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    assert_eq!(response.title.chars().count(), 50);
    assert_eq!(
        service
            .set_session_title(request.clone())
            .now_or_never()
            .expect("memory operation completes immediately")
            .unwrap(),
        response
    );
    assert!(read(&service, &session).title_model_ref.is_empty());
    assert!(matches!(
        service
            .set_session_title(SetSessionTitleRequest {
                session_id: "invalid".into(),
                title: "title".into(),
            })
            .now_or_never()
            .expect("memory operation completes immediately"),
        Err(AgentError::InvalidArgument("session_id"))
    ));
    service
        .delete_session(DeleteSessionRequest {
            targets: vec![DeleteSessionTarget {
                session_id: session.session_id,
                expected_metadata_revision: response.metadata_revision,
                expected_archive_revision: None,
            }],
        })
        .await
        .unwrap();
    assert_eq!(
        service
            .set_session_title(request.clone())
            .now_or_never()
            .expect("memory operation completes immediately"),
        Err(AgentError::NotFound("session"))
    );
    service.close().await.unwrap();
    assert_eq!(
        service
            .set_session_title(request)
            .now_or_never()
            .expect("memory operation completes immediately"),
        Err(AgentError::Closed)
    );
}
