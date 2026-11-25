use std::{
    collections::VecDeque,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::stream;
use tokio::sync::mpsc;
use xw_agent_rollout::{RolloutStore, TestFault};
use xw_agent_types::{
    AgentMessage as ModelMessage, AssistantMessage, ClientRequestId, ContentBlock, EntryPayload,
    FinishReason, InputId, InputModality, ModelCapabilities, SystemContextUpdate, TokenUsage,
};

use super::*;
use crate::{
    AgentHost, AgentTool, AuxiliaryModelRefFuture, EventSubscription, GenerationEvent,
    GenerationFuture, GenerationStream, InputSource, ModelInfo, ModelInfoFuture, SourceKind,
    ToolContext, ToolFuture, ToolRegistration, protocol::*,
};

enum Reply {
    Immediate(AssistantMessage),
    Stream(mpsc::UnboundedReceiver<GenerationEvent>),
}

#[derive(Default)]
struct Host {
    replies: Mutex<VecDeque<Reply>>,
    requests: Mutex<Vec<crate::GenerationRequest>>,
}

impl AgentHost for Host {
    fn get_model_info(&self, model_ref: String) -> ModelInfoFuture {
        Box::pin(async move {
            Ok(ModelInfo {
                model_ref,
                provider_name: "fixture".into(),
                model_name: "fixture".into(),
                capabilities: ModelCapabilities {
                    input_modalities: vec![InputModality::Text],
                    supports_reasoning: false,
                    context_window: 20_000,
                    max_output_tokens: 4_000,
                },
            })
        })
    }

    fn get_auxiliary_model_ref(&self) -> AuxiliaryModelRefFuture {
        Box::pin(async { Ok(None) })
    }

    fn generate(
        &self,
        request: crate::GenerationRequest,
        _: CancellationToken,
    ) -> GenerationFuture {
        self.requests.lock().unwrap().push(request);
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected generation");
        Box::pin(async move {
            let events: GenerationStream = match reply {
                Reply::Immediate(response) => {
                    Box::pin(stream::iter([Ok(GenerationEvent::Finished(response))]))
                }
                Reply::Stream(receiver) => {
                    Box::pin(stream::unfold(receiver, |mut receiver| async {
                        receiver.recv().await.map(|event| (Ok(event), receiver))
                    }))
                }
            };
            Ok(events)
        })
    }
}

impl Host {
    fn reply(&self, message: AssistantMessage) {
        self.replies
            .lock()
            .unwrap()
            .push_back(Reply::Immediate(message));
    }

    fn pause(&self) -> mpsc::UnboundedSender<GenerationEvent> {
        let (send, receive) = mpsc::unbounded_channel();
        self.replies
            .lock()
            .unwrap()
            .push_back(Reply::Stream(receive));
        send
    }
}

fn reply(text: &str, input: u64) -> AssistantMessage {
    AssistantMessage {
        content: vec![ContentBlock::Text {
            text: text.into(),
            signature: None,
        }],
        api: "fixture".into(),
        provider: "fixture".into(),
        model_id: "fixture".into(),
        usage: Some(TokenUsage {
            input,
            output: 10,
            cache_read: 100,
            cache_write: 200,
            total: input + 310,
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
        stop_reason: FinishReason::Stop,
        timestamp_ms: 1,
        response_id: None,
        response_model: None,
        provider_thinking_level: None,
        raw_stop_reason: None,
        end_turn: None,
    }
}

struct FixtureTool(&'static str, &'static str);

impl AgentTool for FixtureTool {
    fn declaration(&self) -> domain::ToolDeclaration {
        domain::ToolDeclaration {
            name: self.0.into(),
            description: self.1.into(),
            parameters_json: r#"{"type":"object","properties":{}}"#.into(),
            constrained_sampling_json: None,
        }
    }

    fn execute<'a>(
        &'a self,
        _: &'a str,
        _: &'a dyn ToolContext,
    ) -> ToolFuture<'a, xw_agent_runtime::tools::ToolOutput> {
        Box::pin(async {
            Ok(xw_agent_runtime::tools::ToolOutput {
                text: "durable fixture tool result".into(),
                metadata_json: None,
            })
        })
    }
}

fn tool(name: &'static str, version: &'static str) -> ToolRegistration {
    ToolRegistration::new(name, Arc::new(FixtureTool(name, version)))
}

async fn open(root: &Path, host: &Arc<Host>, tools: Vec<ToolRegistration>) -> AgentService {
    let service = AgentService::open(host.clone(), root.into()).await.unwrap();
    service.set_tools(tools).unwrap();
    service
}

async fn create(service: &AgentService) -> String {
    service
        .create_session(CreateSessionRequest {
            client_request_id: ClientRequestId::new().to_string(),
            config: Some(AgentModelConfig {
                model_ref: "fixture".into(),
                ..Default::default()
            }),
            ..Default::default()
        })
        .await
        .unwrap()
        .session
        .unwrap()
        .session_id
}

fn input(text: &str) -> Vec<AgentUserInput> {
    vec![AgentUserInput {
        content: Some(agent_user_input::Content::Text(text.into())),
    }]
}

fn source() -> InputSource {
    InputSource {
        kind: SourceKind::Cli,
        principal_id: "fixture".into(),
    }
}

async fn send(service: &AgentService, id: &str, text: &str) -> AgentRun {
    service
        .start_run(
            StartRunRequest {
                session_id: id.into(),
                input_id: InputId::new().to_string(),
                input: input(text),
                ..Default::default()
            },
            source(),
        )
        .await
        .unwrap()
        .run
        .unwrap()
}

async fn subscribe(service: &AgentService, id: &str) -> EventSubscription {
    service
        .subscribe_session(SubscribeSessionRequest {
            session_id: id.into(),
        })
        .await
        .unwrap()
}

async fn matching<T>(
    events: &mut EventSubscription,
    mut pick: impl FnMut(agent_event::Payload) -> Option<T>,
) -> T {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap().unwrap();
            if let Some(value) = event.payload.and_then(&mut pick) {
                return value;
            }
        }
    })
    .await
    .expect("expected session event")
}

async fn completed(events: &mut EventSubscription) -> AgentRun {
    matching(events, |payload| match payload {
        agent_event::Payload::RunCompleted(end) => end.run,
        _ => None,
    })
    .await
}

async fn compaction_started(events: &mut EventSubscription) -> AgentGeneration {
    matching(events, |payload| match payload {
        agent_event::Payload::GenerationUpdated(update) => update
            .generation
            .filter(|generation| generation.is_compaction),
        _ => None,
    })
    .await
}

fn journal(root: &Path, id: &str) -> Vec<domain::JournalEntry> {
    let (journal, _) = RolloutStore::new(root).open(id.parse().unwrap()).unwrap();
    journal.entries().to_vec()
}

fn checkpoints(entries: &[domain::JournalEntry]) -> Vec<&domain::Compacted> {
    entries
        .iter()
        .filter_map(|entry| match &entry.payload {
            EntryPayload::Compacted(checkpoint) => Some(checkpoint),
            _ => None,
        })
        .collect()
}

fn assert_completed(run: AgentRun) {
    assert_eq!(run.status, AgentRunStatus::Completed as i32, "{run:?}");
}

#[tokio::test]
async fn pre_run_compaction_replays_current_baseline_and_preserves_original_history() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = open(
        root.path(),
        &host,
        vec![tool("Fixture", "v1"), tool("Gone", "v1")],
    )
    .await;
    let id = create(&service).await;
    let mut events = subscribe(&service, &id).await;
    let original = "long original answer ".repeat(120);

    host.reply(reply(&original, 15_600));
    send(&service, &id, "original request").await;
    assert_completed(completed(&mut events).await);
    service.close().await.unwrap();

    let service = open(
        root.path(),
        &host,
        vec![tool("Fixture", "v2"), tool("New", "v1")],
    )
    .await;
    let mut events = subscribe(&service, &id).await;
    host.reply(reply("summary with prior facts", 16_500));
    host.reply(reply("follow-up answer", 150));
    host.reply(reply("unchanged baseline", 150));
    send(&service, &id, "follow-up").await;
    let generation = compaction_started(&mut events).await;
    assert_completed(completed(&mut events).await);
    send(&service, &id, "another question").await;
    assert_completed(completed(&mut events).await);

    let saved = service
        .read_session(ReadSessionRequest {
            session_id: id.clone(),
            include_runs: true,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    let displayed = format!("{:?}", saved.runs);
    assert!(displayed.contains(&original));
    assert!(!displayed.contains("summary with prior facts"));
    service.close().await.unwrap();

    let service = open(
        root.path(),
        &host,
        vec![tool("Fixture", "v3"), tool("New", "v1")],
    )
    .await;
    let mut events = subscribe(&service, &id).await;
    host.reply(reply("new schema answer", 16_000));
    send(&service, &id, "schema changed").await;
    assert_completed(completed(&mut events).await);
    host.reply(reply("updated summary", 300));
    host.reply(reply("answer after repeated compaction", 150));
    send(&service, &id, "repeat compaction").await;
    compaction_started(&mut events).await;
    assert_completed(completed(&mut events).await);
    service.close().await.unwrap();

    let seen = host.requests.lock().unwrap();
    assert_eq!(seen.len(), 7);
    let summary = &seen[1];
    assert!(summary.isolate_provider_session);
    assert_eq!(summary.max_tokens, Some(4_000));
    let encoded = serde_json::to_string(&summary.messages).unwrap();
    assert!(encoded.contains(&original));
    assert!(encoded.contains("Distinguish observed and unknown outcomes."));
    assert!(!encoded.contains("follow-up"));
    assert!(!encoded.contains("system_context"));

    let follow_up = &seen[2];
    assert!(!follow_up.isolate_provider_session);
    let Some(ModelMessage::SystemContext {
        update: SystemContextUpdate::Baseline(base),
    }) = follow_up.messages.first()
    else {
        panic!("missing rebuilt system baseline");
    };
    assert!(
        base.tools
            .iter()
            .any(|tool| tool.name == "Fixture" && tool.description == "v2")
    );
    assert!(base.tools.iter().any(|tool| tool.name == "New"));
    assert!(!base.tools.iter().any(|tool| tool.name == "Gone"));
    for request in &seen[2..=3] {
        assert_eq!(
            request
                .messages
                .iter()
                .filter(|message| matches!(message, ModelMessage::SystemContext { .. }))
                .count(),
            1
        );
    }
    let encoded = serde_json::to_string(&follow_up.messages).unwrap();
    assert!(encoded.contains("summary with prior facts"));
    assert!(encoded.contains("original request"));
    assert!(encoded.contains("follow-up"));
    assert!(!encoded.contains(&original));

    let updates = seen[4]
        .messages
        .iter()
        .filter_map(|message| match message {
            ModelMessage::SystemContext { update } => Some(update),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(updates.len(), 2);
    let SystemContextUpdate::Delta(delta) = updates[1] else {
        panic!("new change must append one delta");
    };
    let delta = serde_json::to_string(delta).unwrap();
    assert!(delta.contains("Fixture") && delta.contains("v3"));
    assert!(!delta.contains("\"New\""));

    let repeated = serde_json::to_string(&seen[6].messages).unwrap();
    assert!(repeated.contains("updated summary") && repeated.contains("original request"));
    assert!(!repeated.contains("summary with prior facts"));

    let entries = journal(root.path(), &id);
    let checkpoints = checkpoints(&entries);
    assert_eq!(checkpoints.len(), 2);
    let checkpoint = checkpoints[0];
    let first_checkpoint_entry = entries
        .iter()
        .find(|entry| matches!(entry.payload, EntryPayload::Compacted(_)))
        .unwrap();
    assert_eq!(
        checkpoints[1].previous_checkpoint_id,
        Some(first_checkpoint_entry.entry_id)
    );
    assert_eq!(checkpoint.gen_id.to_string(), generation.gen_id);
    assert_eq!(checkpoint.trigger, domain::CompactionTrigger::AutoPreRun);
    assert_eq!(checkpoint.tokens_before, Some(15_900));
    assert_eq!(checkpoint.summary, "summary with prior facts");
    let before = crate::rebuild_context(&entries, &checkpoint.boundary).unwrap();
    assert!(
        serde_json::to_string(&before.messages)
            .unwrap()
            .contains(&original)
    );
    let end = entries
        .iter()
        .find_map(|entry| match &entry.payload {
            EntryPayload::GenEnded(end) if end.gen_id == checkpoint.gen_id => Some(end),
            _ => None,
        })
        .unwrap();
    assert_eq!(end.usage.as_ref().unwrap().input, 16_500);
    assert_eq!(end.context_tokens, None);
}

#[tokio::test]
async fn between_turns_compaction_waits_for_durable_tool_results() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = open(root.path(), &host, vec![tool("Fixture", "v1")]).await;
    let id = create(&service).await;
    let mut events = subscribe(&service, &id).await;
    let mut call = reply("ignored", 15_750);
    call.stop_reason = FinishReason::ToolUse;
    call.content = vec![ContentBlock::ToolCall {
        id: "fixture-call".into(),
        name: "Fixture".into(),
        arguments_json: Some("{}".into()),
        thought_signature: None,
        namespace: None,
    }];
    host.reply(call);
    host.reply(reply("tool completed with fixture result", 500));
    host.reply(reply("final answer", 200));
    send(&service, &id, "run the fixture tool").await;
    compaction_started(&mut events).await;
    let done = completed(&mut events).await;
    assert!(done.items.iter().any(|item| matches!(&item.content,
        Some(agent_item::Content::ToolCall(call))
            if call.output == "durable fixture tool result"
    )));
    assert_completed(done);
    service.close().await.unwrap();

    let requests = host.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].messages.iter().any(|message| matches!(message,
        ModelMessage::ToolResult(result) if result.tool_call_id == "fixture-call"
    )));
    assert!(!requests[2].messages.iter().any(|message| matches!(
        message,
        ModelMessage::ToolResult(_) | ModelMessage::Assistant(_)
    )));

    let entries = journal(root.path(), &id);
    let checkpoints = checkpoints(&entries);
    assert_eq!(checkpoints.len(), 1);
    let checkpoint = checkpoints[0];
    assert_eq!(
        checkpoint.trigger,
        domain::CompactionTrigger::AutoBetweenTurns
    );
    let turn_id = checkpoint.boundary.after_turn_id.unwrap();
    assert!(entries.iter().any(|entry| matches!(&entry.payload, EntryPayload::TurnEnded(turn)
        if turn.turn_id == turn_id && Some(entry.entry_id) == checkpoint.boundary.through_entry_id
    )));
    assert!(
        entries
            .iter()
            .any(|entry| matches!(entry.payload, EntryPayload::ToolOutcome(_)))
    );
}

#[tokio::test]
async fn empty_summary_stop_and_failed_checkpoint_leave_prior_context_effective() {
    for case in ["empty", "stop", "checkpoint_sync", "replacement_too_large"] {
        let root = tempfile::tempdir().unwrap();
        let host = Arc::new(Host::default());
        let service = open(root.path(), &host, vec![]).await;
        let id = create(&service).await;
        let mut events = subscribe(&service, &id).await;
        host.reply(reply("original answer", 16_000));
        send(&service, &id, "original question").await;
        assert_completed(completed(&mut events).await);

        let summary = host.pause();
        let failed = send(&service, &id, "unconsumed follow-up").await;
        let started = compaction_started(&mut events).await;
        if case == "stop" {
            let response = service
                .interrupt_run(InterruptRunRequest {
                    session_id: id.clone(),
                    run_id: failed.run_id,
                })
                .unwrap();
            assert!(response.cancellation_requested);
        } else {
            if case == "checkpoint_sync" {
                let mut state = service.state().unwrap();
                let session = state.sessions.get_mut(&id.parse().unwrap()).unwrap();
                // Summary Message and GenEnded commit first, then the checkpoint sync fails.
                session
                    .journal
                    .as_mut()
                    .unwrap()
                    .fail_append_after(2, TestFault::Sync);
            }
            let text = match case {
                "empty" => String::new(),
                "replacement_too_large" => "x".repeat(65_000),
                _ => "use this only after commit".into(),
            };
            let mut message = reply(&text, 40);
            if case == "empty" {
                message.content.clear();
            }
            summary.send(GenerationEvent::Finished(message)).unwrap();
        }
        let finished = completed(&mut events).await;
        let expected = if case == "stop" {
            AgentRunStatus::Interrupted
        } else {
            AgentRunStatus::Failed
        };
        assert_eq!(finished.status, expected as i32, "{case}: {finished:?}");
        assert_eq!(host.requests.lock().unwrap().len(), 2);
        {
            let state = service.state().unwrap();
            let session = &state.sessions[&id.parse().unwrap()];
            assert!(session.summary_index.is_none(), "{case}");
            assert!(
                serde_json::to_string(&session.history)
                    .unwrap()
                    .contains("original answer")
            );
        }
        service.close().await.unwrap();

        let service = open(root.path(), &host, vec![]).await;
        let read = service
            .read_session(ReadSessionRequest {
                session_id: id.clone(),
                include_runs: true,
            })
            .await
            .unwrap()
            .session
            .unwrap();
        assert_eq!(read.runs.last().unwrap().status, expected as i32, "{case}");
        service.close().await.unwrap();
        let entries = journal(root.path(), &id);
        assert!(checkpoints(&entries).is_empty(), "{case}");
        assert_eq!(
            entries
                .iter()
                .filter(|entry| matches!(&entry.payload,
                    EntryPayload::GenStarted(generation)
                            if generation.purpose == domain::GenPurpose::Conversation
                ))
                .count(),
            1,
            "{case}"
        );
        let current = crate::rebuild_context(
            &entries,
            &domain::ContextBoundary {
                through_entry_id: entries.last().map(|entry| entry.entry_id),
                after_turn_id: None,
            },
        )
        .unwrap();
        let current = serde_json::to_string(&current.messages).unwrap();
        assert!(current.contains("original answer"));
        assert!(!current.contains("unconsumed follow-up"));
        assert!(
            entries
                .iter()
                .any(|entry| matches!(&entry.payload, EntryPayload::GenEnded(end)
                    if end.gen_id.to_string() == started.gen_id
                ))
        );
    }
}

#[tokio::test]
async fn stopped_preflight_leaves_follow_up_pending_without_consuming_it_twice() {
    let root = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let service = open(root.path(), &host, vec![]).await;
    let id = create(&service).await;
    let mut events = subscribe(&service, &id).await;
    let first = host.pause();
    let _summary = host.pause();
    send(&service, &id, "initial").await;

    let input_id = InputId::new().to_string();
    let text = input("pending follow-up");
    service
        .queue_input(
            QueueInputRequest {
                session_id: id.clone(),
                input_id: input_id.clone(),
                input: text.clone(),
            },
            source(),
        )
        .await
        .unwrap();
    first
        .send(GenerationEvent::Finished(reply("original answer", 16_000)))
        .unwrap();
    assert_completed(completed(&mut events).await);
    compaction_started(&mut events).await;

    let request = StartRunRequest {
        session_id: id.clone(),
        input_id: input_id.clone(),
        input: text,
        ..Default::default()
    };
    let active = service
        .start_run(request, source())
        .await
        .unwrap()
        .run
        .unwrap();
    service
        .interrupt_run(InterruptRunRequest {
            session_id: id.clone(),
            run_id: active.run_id.clone(),
        })
        .unwrap();
    let stopped = completed(&mut events).await;
    assert_eq!(stopped.run_id, active.run_id);
    assert_eq!(stopped.status, AgentRunStatus::Interrupted as i32);
    service.close().await.unwrap();

    let entries = journal(root.path(), &id);
    let queued = input_id.parse().unwrap();
    assert_eq!(
        crate::inspect_recovery(&entries).unwrap().pending_inputs,
        [queued]
    );

    let service = open(root.path(), &host, vec![]).await;
    let mut events = subscribe(&service, &id).await;
    host.reply(reply("successful summary after stop", 200));
    host.reply(reply("successful follow-up", 200));
    service
        .interrupt_input(QueuedInputActionRequest {
            session_id: id.clone(),
            input_id,
            run_id: None,
        })
        .await
        .unwrap();
    let retried = completed(&mut events).await;
    assert_ne!(retried.run_id, active.run_id);
    assert_ne!(retried.items[0].item_id, active.items[0].item_id);
    let item_id = retried.items[0].item_id.clone();
    assert_completed(retried);
    service.close().await.unwrap();

    let service = open(root.path(), &host, vec![]).await;
    let restored = service
        .read_session(ReadSessionRequest {
            session_id: id.clone(),
            include_runs: true,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    let last = restored.runs.last().unwrap();
    assert_eq!(last.items[0].item_id, item_id);
    assert_eq!(last.items.len(), 2);
    service.close().await.unwrap();

    let entries = journal(root.path(), &id);
    assert_eq!(entries.iter().filter(|entry| {
        matches!(&entry.payload, EntryPayload::InputConsumed(input) if input.input_ids == [queued])
    }).count(), 1);
}
