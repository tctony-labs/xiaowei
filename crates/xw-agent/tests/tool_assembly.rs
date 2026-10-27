use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::stream;
use xw_agent::{
    AgentHost, AgentService, AgentTool, CancellationToken, GenerationEvent, GenerationFuture,
    GenerationRequest, GenerationStream, InputSource, RecoveryPolicy, SourceKind, ToolContext,
    ToolFuture, ToolRegistration, protocol::*,
};
use xw_agent_types as domain;

struct Host {
    requests: Mutex<Vec<GenerationRequest>>,
    auxiliary: bool,
}

impl Host {
    fn new(auxiliary: bool) -> Arc<Self> {
        Arc::new(Self {
            requests: Mutex::new(vec![]),
            auxiliary,
        })
    }
}

fn message(
    content: Vec<domain::ContentBlock>,
    reason: domain::FinishReason,
) -> domain::AssistantMessage {
    domain::AssistantMessage {
        content,
        api: "fixture".into(),
        provider: "fixture".into(),
        model_id: "test".into(),
        usage: Some(domain::TokenUsage {
            input: 12,
            output: 4,
            total: 16,
            cache_read: 0,
            cache_write: 0,
            reasoning: None,
            cache_write_1h: None,
            cost: Some(domain::UsageCost {
                input: 0.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
                total: 0.0,
            }),
        }),
        stop_reason: reason,
        timestamp_ms: 1,
        response_id: Some("raw-response-id".into()),
        response_model: Some("actual-model".into()),
        provider_thinking_level: None,
        raw_stop_reason: Some("stop".into()),
        end_turn: Some(true),
    }
}

impl AgentHost for Host {
    fn get_model_info(&self, model_ref: String) -> xw_agent::ModelInfoFuture {
        Box::pin(async move {
            Ok(domain::ModelInfo {
                model_ref,
                provider_name: "fixture".into(),
                model_name: "test".into(),
                capabilities: domain::ModelCapabilities {
                    input_modalities: vec![domain::InputModality::Text],
                    supports_reasoning: true,
                    context_window: 100_000,
                    max_output_tokens: 1000,
                },
            })
        })
    }

    fn get_auxiliary_model_ref(&self) -> xw_agent::AuxiliaryModelRefFuture {
        let available = self.auxiliary;
        Box::pin(async move { Ok(available.then(|| "small".into())) })
    }

    fn generate(&self, request: GenerationRequest, _: CancellationToken) -> GenerationFuture {
        let auxiliary = request.model_ref == "small";
        let call = matches!(request.messages.last(), Some(domain::AgentMessage::User(_)));
        self.requests.lock().unwrap().push(request);
        let content = if auxiliary {
            vec![domain::ContentBlock::Text {
                text: "extracted".into(),
                signature: None,
            }]
        } else if call {
            vec![domain::ContentBlock::ToolCall {
                id: "call".into(),
                name: "Fixture".into(),
                arguments_json: Some("{}".into()),
                thought_signature: None,
                namespace: None,
            }]
        } else {
            vec![domain::ContentBlock::Text {
                text: "done".into(),
                signature: None,
            }]
        };
        let reason = if call && !auxiliary {
            domain::FinishReason::ToolUse
        } else {
            domain::FinishReason::Stop
        };
        let mut events = vec![];
        if auxiliary {
            events
                .extend([1, 2].map(|received_at_ms| {
                    Ok(GenerationEvent::FirstSseReceived { received_at_ms })
                }));
            // More than the bounded channel capacity: extraction must consume events.
            events.extend((0..100).map(|_| {
                Ok(GenerationEvent::TextDelta {
                    content_index: 0,
                    text: "x".into(),
                })
            }));
        }
        events.push(Ok(GenerationEvent::Finished(message(content, reason))));
        Box::pin(async move { Ok(Box::pin(stream::iter(events)) as GenerationStream) })
    }
}

struct Fixture {
    version: &'static str,
    extract: bool,
}

impl AgentTool for Fixture {
    fn declaration(&self) -> domain::ToolDeclaration {
        domain::ToolDeclaration {
            name: "Fixture".into(),
            description: self.version.into(),
            parameters_json: r#"{"type":"object","properties":{}}"#.into(),
            constrained_sampling_json: None,
        }
    }

    fn rules(&self) -> BTreeMap<String, String> {
        BTreeMap::from([("tool.Fixture".into(), self.version.into())])
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
            let text = if self.extract {
                context
                    .extract_text("private page input".into(), "extract".into())
                    .await?
            } else {
                self.version.into()
            };
            Ok(xw_agent_runtime::tools::ToolOutput {
                text,
                metadata_json: None,
            })
        })
    }
}

fn registration(version: &'static str, extract: bool) -> ToolRegistration {
    ToolRegistration::new("fixture", Arc::new(Fixture { version, extract }))
}

fn creation() -> CreateSessionRequest {
    CreateSessionRequest {
        client_request_id: domain::ClientRequestId::new().to_string(),
        config: Some(AgentModelConfig {
            model_ref: "chat".into(),
            reasoning: None,
        }),
        ..Default::default()
    }
}

async fn run(service: &AgentService, session_id: &str) -> AgentRun {
    let mut events = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session_id.into(),
        })
        .await
        .unwrap();
    service
        .start_run(
            StartRunRequest {
                session_id: session_id.into(),
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

fn tool(run: &AgentRun) -> &AgentToolCall {
    run.items
        .iter()
        .find_map(|item| match &item.content {
            Some(agent_item::Content::ToolCall(tool)) => Some(tool),
            _ => None,
        })
        .unwrap()
}

fn context(request: &GenerationRequest) -> domain::SystemContext {
    let mut current = None;
    for message in &request.messages {
        if let domain::AgentMessage::SystemContext { update } = message {
            current = Some(update.apply(current.as_ref()).unwrap());
        }
    }
    current.unwrap()
}

#[tokio::test]
async fn registrations_freeze_at_creation_including_first_run_and_idempotent_retries() {
    let host = Host::new(false);
    let service = AgentService::new(host.clone());
    service.set_tools(vec![registration("v1", false)]).unwrap();
    let request = creation();
    let a = service
        .create_session(request.clone())
        .await
        .unwrap()
        .session
        .unwrap();
    assert!(a.cwd.is_none());
    service
        .update_tool(
            "fixture",
            Arc::new(Fixture {
                version: "v2",
                extract: false,
            }),
        )
        .unwrap();
    let retried = service
        .create_session(request)
        .await
        .unwrap()
        .session
        .unwrap();
    assert_eq!(a.session_id, retried.session_id);
    let b = service
        .create_session(creation())
        .await
        .unwrap()
        .session
        .unwrap();
    assert_eq!(tool(&run(&service, &a.session_id).await).output, "v1");
    assert_eq!(tool(&run(&service, &b.session_id).await).output, "v2");
    service.set_tools(vec![]).unwrap();
    assert_eq!(tool(&run(&service, &a.session_id).await).output, "v1");
    let requests = host.requests.lock().unwrap().clone();
    for (index, version) in [(0, "v1"), (2, "v2"), (4, "v1")] {
        let system = context(&requests[index]);
        assert_eq!(system.tools[0].description, version);
        assert_eq!(system.instructions["tool.Fixture"], version);
        assert_eq!(
            requests[index]
                .messages
                .iter()
                .filter(|message| { matches!(message, domain::AgentMessage::SystemContext { .. }) })
                .count(),
            1
        );
    }
    drop(requests);
    service.close().await.unwrap();
}

#[tokio::test]
async fn invalid_replacement_is_atomic_and_empty_external_tools_are_supported() {
    let service = AgentService::new(Host::new(false));
    service.set_tools(vec![registration("v1", false)]).unwrap();
    assert!(
        service
            .set_tools(vec![registration("v2", false), registration("v3", false)])
            .is_err()
    );
    let a = service
        .create_session(creation())
        .await
        .unwrap()
        .session
        .unwrap();
    assert_eq!(tool(&run(&service, &a.session_id).await).output, "v1");
    service.set_tools(vec![]).unwrap();
    let b = service
        .create_session(creation())
        .await
        .unwrap()
        .session
        .unwrap();
    assert_eq!(
        tool(&run(&service, &b.session_id).await).status,
        AgentToolStatus::Failed as i32
    );
    service.close().await.unwrap();
}

#[tokio::test]
async fn auxiliary_generation_has_independent_identity_usage_and_no_chat_projection() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::new(true);
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    service.set_tools(vec![registration("v1", true)]).unwrap();
    let session = service
        .create_session(creation())
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
    let completed = run(&service, &session.session_id).await;
    assert_eq!(
        completed.status,
        AgentRunStatus::Completed as i32,
        "{completed:?}"
    );
    assert_eq!(tool(&completed).output, "extracted");
    assert_eq!(completed.items.len(), 3);
    let requests = host.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[1].model_ref, "small");
    assert_eq!(requests[1].max_tokens, Some(1000));
    assert_eq!(requests[1].temperature, Some(0.3));
    assert_eq!(requests[1].reasoning.as_deref(), Some("off"));
    assert!(!requests[2].messages.iter().any(|message| {
        matches!(message, domain::AgentMessage::Assistant(message)
            if message.content.iter().any(|block| matches!(block,
                domain::ContentBlock::Text { text, .. } if text == "extracted")))
    }));
    drop(requests);
    service.close().await.unwrap();
    drop(service);
    let store = xw_agent_rollout::RolloutStore::new(root.path());
    let (journal, _) = store.open(session.session_id.parse().unwrap()).unwrap();
    let entries = journal.entries();
    domain::validate_history(entries).unwrap();
    let extraction = entries
        .iter()
        .find_map(|entry| match &entry.payload {
            domain::EntryPayload::GenStarted(generation)
                if matches!(
                    generation.purpose,
                    domain::GenPurpose::ToolExtraction { .. }
                ) =>
            {
                Some(generation)
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(extraction.turn_id, None);
    assert_eq!(extraction.run_id.unwrap().to_string(), completed.run_id);
    assert!(extraction.context.as_ref().unwrap().tools.is_empty());
    assert_ne!(
        completed.final_gen_id.as_deref(),
        Some(extraction.gen_id.to_string().as_str())
    );
    assert_eq!(entries.iter().filter(|entry| matches!(&entry.payload,
        domain::EntryPayload::GenFirstSseReceived(first) if first.gen_id == extraction.gen_id
    )).count(), 1);
    let end = entries
        .iter()
        .find_map(|entry| match &entry.payload {
            domain::EntryPayload::GenEnded(end) if end.gen_id == extraction.gen_id => Some(end),
            _ => None,
        })
        .unwrap();
    assert_eq!(end.usage.as_ref().unwrap().total, 16);
    assert!(
        entries
            .iter()
            .filter_map(|entry| match &entry.payload {
                domain::EntryPayload::ToolOutcome(outcome) => Some(outcome),
                _ => None,
            })
            .all(|outcome| matches!(&outcome.result.message,
        domain::AgentMessage::ToolResult(result) if result.usage.is_none()))
    );
    let raw = entries
        .iter()
        .find_map(|entry| match &entry.payload {
            domain::EntryPayload::Message(message) if message.gen_id == Some(extraction.gen_id) => {
                Some(message)
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(raw.turn_id, None);
    assert!(
        matches!(&raw.message, domain::AgentMessage::Assistant(message)
        if message.response_id.as_deref() == Some("raw-response-id"))
    );
    drop(journal);
    let reopened = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    reopened.set_tools(vec![registration("v2", true)]).unwrap();
    let restored = reopened
        .read_session(ReadSessionRequest {
            session_id: session.session_id,
            include_runs: true,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    assert_eq!(restored.runs[0].items, completed.items);
    assert_eq!(restored.runs[0].final_gen_id, completed.final_gen_id);
    assert_eq!(restored.runs[0].status, completed.status);
    assert_eq!(host.requests.lock().unwrap().len(), 3);
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn missing_auxiliary_model_is_a_failed_tool_and_conversation_can_continue() {
    let host = Host::new(false);
    let service = AgentService::new(host.clone());
    service.set_tools(vec![registration("v1", true)]).unwrap();
    let session = service
        .create_session(creation())
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
    let completed = run(&service, &session.session_id).await;
    assert_eq!(
        completed.status,
        AgentRunStatus::Completed as i32,
        "{completed:?}"
    );
    assert_eq!(tool(&completed).status, AgentToolStatus::Failed as i32);
    assert!(tool(&completed).output.contains("小文本任务模型"));
    assert_eq!(host.requests.lock().unwrap().len(), 2);
    service.close().await.unwrap();
}
