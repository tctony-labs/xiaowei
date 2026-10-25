use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::stream;
use tokio::sync::mpsc;
use xw_agent::{
    AgentHost, AgentService, CancellationToken, GenerationEvent, GenerationFuture,
    GenerationRequest, GenerationStream, InputSource, SourceKind, protocol::*,
};
use xw_agent_types::{
    AssistantMessage, ClientRequestId, ContentBlock, FinishReason, InputId, TokenUsage, UsageCost,
};

type ModelEvents = mpsc::UnboundedReceiver<Result<GenerationEvent, xw_agent::GenerationError>>;

struct Host(Mutex<VecDeque<ModelEvents>>);

impl AgentHost for Host {
    fn get_model_info(&self, _: String) -> xw_agent::ModelInfoFuture {
        Box::pin(async { Err(xw_agent::ModelInfoError::Unavailable) })
    }

    fn get_auxiliary_model_ref(&self) -> xw_agent::AuxiliaryModelRefFuture {
        Box::pin(async { Ok(None) })
    }

    fn generate(&self, _: GenerationRequest, _: CancellationToken) -> GenerationFuture {
        let events = self
            .0
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected generation");
        Box::pin(async move {
            let events = stream::unfold(events, |mut receiver| async {
                receiver.recv().await.map(|event| (event, receiver))
            });
            Ok(Box::pin(events) as GenerationStream)
        })
    }
}

fn message(content: Vec<ContentBlock>, stop_reason: FinishReason) -> AssistantMessage {
    AssistantMessage {
        content,
        api: "fixture".into(),
        provider: "fixture".into(),
        model_id: "test".into(),
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
        stop_reason,
        timestamp_ms: 1,
        response_id: None,
        response_model: None,
        provider_thinking_level: None,
        raw_stop_reason: None,
        end_turn: None,
    }
}

async fn changed(events: &mut xw_agent::EventSubscription) -> GenerationUpdated {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match events.recv().await.unwrap().unwrap().payload {
                Some(agent_event::Payload::GenerationUpdated(change)) => return change,
                Some(agent_event::Payload::RunCompleted(end)) => {
                    panic!("Run ended before expected Generate transition: {end:?}");
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap()
}

async fn snapshot(service: &AgentService, session_id: &str) -> AgentRun {
    let mut observer = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session_id.into(),
        })
        .await
        .unwrap();
    let Some(agent_event::Payload::SubscriptionReady(ready)) =
        observer.recv().await.unwrap().unwrap().payload
    else {
        panic!("missing initial snapshot");
    };
    ready.session.unwrap().runs.pop().unwrap()
}

#[tokio::test]
async fn generate_state_reconnects_across_tools_and_empty_final_response_survives_reopen() {
    let root = tempfile::tempdir().unwrap();
    let (first, first_events) = mpsc::unbounded_channel();
    let (second, second_events) = mpsc::unbounded_channel();
    let host = Arc::new(Host(Mutex::new(VecDeque::from([
        first_events,
        second_events,
    ]))));
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let session = service
        .create_session(CreateSessionRequest {
            client_request_id: ClientRequestId::new().to_string(),
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
    let mut events = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .await
        .unwrap();
    let accepted = service
        .start_run(
            StartRunRequest {
                session_id: session.session_id.clone(),
                input_id: InputId::new().to_string(),
                input: vec![AgentUserInput {
                    content: Some(agent_user_input::Content::Text("find configuration".into())),
                }],
                ..Default::default()
            },
            InputSource {
                kind: SourceKind::Cli,
                principal_id: "fixture".into(),
            },
        )
        .await
        .unwrap()
        .run
        .unwrap();
    let opening = snapshot(&service, &session.session_id)
        .await
        .generation
        .unwrap();
    assert_eq!(accepted.generation, Some(opening.clone()));
    assert!(!opening.received_content);
    assert!(opening.active_item_id.is_none());

    first
        .send(Ok(GenerationEvent::TextDelta {
            content_index: 0,
            text: "I will inspect the configuration.".into(),
        }))
        .unwrap();
    let streaming = changed(&mut events).await.generation.unwrap();
    assert!(streaming.received_content);
    let active_id = streaming.active_item_id.as_ref().unwrap();
    let current = snapshot(&service, &session.session_id).await;
    assert_eq!(current.generation, Some(streaming.clone()));
    assert!(current.items.iter().any(|item| {
        &item.item_id == active_id && item.gen_id.as_ref() == Some(&opening.gen_id)
    }));

    let text = ContentBlock::Text {
        text: "I will inspect the configuration.".into(),
        signature: None,
    };
    first
        .send(Ok(GenerationEvent::BlockFinished {
            content_index: 0,
            block: text.clone(),
        }))
        .unwrap();
    let paused = changed(&mut events).await.generation.unwrap();
    assert!(paused.received_content);
    assert!(paused.active_item_id.is_none());
    first
        .send(Ok(GenerationEvent::Finished(message(
            vec![
                text,
                ContentBlock::ToolCall {
                    id: "glob".into(),
                    name: "Glob".into(),
                    arguments_json: Some(r#"{"pattern":"*.json"}"#.into()),
                    thought_signature: None,
                    namespace: None,
                },
            ],
            FinishReason::ToolUse,
        ))))
        .unwrap();

    assert!(changed(&mut events).await.generation.is_none());
    let next = changed(&mut events).await.generation.unwrap();
    assert_ne!(next.gen_id, opening.gen_id);
    assert!(next.started_at_ms >= opening.started_at_ms);
    assert!(!next.received_content);
    assert!(next.active_item_id.is_none());
    let waiting = snapshot(&service, &session.session_id).await;
    assert_eq!(waiting.generation, Some(next.clone()));
    let completed = AgentToolStatus::Completed as i32;
    assert!(waiting.items.iter().any(|item| matches!(
        &item.content,
        Some(agent_item::Content::ToolCall(tool)) if tool.status == completed
    )));

    second
        .send(Ok(GenerationEvent::Finished(message(
            vec![],
            FinishReason::Stop,
        ))))
        .unwrap();
    let final_run = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(agent_event::Payload::RunCompleted(end)) =
                events.recv().await.unwrap().unwrap().payload
            {
                break end.run.unwrap();
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(final_run.status, AgentRunStatus::Completed as i32);
    assert_eq!(final_run.final_gen_id, Some(next.gen_id.clone()));
    assert!(final_run.generation.is_none());
    assert!(
        !final_run
            .items
            .iter()
            .any(|item| item.gen_id.as_ref() == Some(&next.gen_id))
    );
    service.close().await.unwrap();

    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let restored = snapshot(&service, &session.session_id).await;
    assert_eq!(restored.status, final_run.status);
    assert_eq!(restored.final_gen_id, final_run.final_gen_id);
    assert_eq!(restored.items, final_run.items);
    assert!(restored.generation.is_none());
    assert!(host.0.lock().unwrap().is_empty());
    service.close().await.unwrap();
}
