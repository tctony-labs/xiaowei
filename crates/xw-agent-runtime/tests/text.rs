use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use futures_util::{StreamExt, stream};
use tokio::sync::mpsc;
use xw_agent_runtime::RunStatus;
use xw_agent_runtime::*;
use xw_agent_types::*;

fn message(reason: FinishReason) -> AssistantMessage {
    AssistantMessage {
        content: vec![ContentBlock::Text {
            text: "final authoritative".into(),
            signature: Some("sig".into()),
        }],
        api: "test-api".into(),
        provider: "test-provider".into(),
        model_id: "upstream".into(),
        usage: None,
        stop_reason: reason,
        timestamp_ms: 5,
        response_id: Some("response".into()),
        response_model: None,
        provider_thinking_level: Some("high".into()),
        raw_stop_reason: None,
        end_turn: Some(true),
    }
}

struct Model {
    events: Vec<GenerationEvent>,
    calls: AtomicUsize,
    drops: Arc<AtomicUsize>,
    opening: bool,
    pending: bool,
}
struct Dropped(Arc<AtomicUsize>);
impl Drop for Dropped {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
impl LlmGeneration for Model {
    fn generate(&self, _: GenerationRequest, _: CancellationToken) -> GenerationFuture {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let events = self.events.clone();
        let guard = Dropped(self.drops.clone());
        let opening = self.opening;
        let pending = self.pending;
        Box::pin(async move {
            if opening {
                futures_util::future::pending::<()>().await;
            }
            let stream = stream::unfold((events.into_iter(), guard), move |(mut events, guard)| async move {
                match events.next() {
                    Some(event) => Some((Ok(event), (events, guard))),
                    None if pending => futures_util::future::pending().await,
                    None => None,
                }
            });
            Ok(Box::pin(stream) as GenerationStream)
        })
    }
}
fn model(events: Vec<GenerationEvent>) -> Arc<Model> {
    Arc::new(Model {
        events,
        calls: AtomicUsize::new(0),
        drops: Arc::new(AtomicUsize::new(0)),
        opening: false,
        pending: false,
    })
}
fn request() -> RunRequest {
    let session_id = SessionId::new();
    RunRequest {
        session_id,
        input_id: InputId::new(),
        run_id: RunId::new(),
        turn_id: TurnId::new(),
        gen_id: GenId::new(),
        message_id: MessageId::new(),
        generation: GenerationRequest {
            temperature: None,
            max_tokens: None,
            session_id,
            model_ref: "test".into(),
            system_prompt: String::new(),
            messages: vec![],
            reasoning: None,
        },
    }
}

#[tokio::test]
async fn complete_final_preserves_metadata_and_length_instead_of_delta_text() {
    for reason in [FinishReason::Stop, FinishReason::Length] {
        let final_message = message(reason);
        let model = model(vec![
            GenerationEvent::ThinkingDelta {
                content_index: 0,
                text: "思考".into(),
            },
            GenerationEvent::TextDelta {
                content_index: 1,
                text: "display only".into(),
            },
            GenerationEvent::Finished(final_message.clone()),
        ]);
        let (tx, mut rx) = mpsc::channel(8);
        let result = execute_text(request(), model.clone(), CancellationToken::new(), tx).await;
        assert_eq!(result.status, RunStatus::Completed);
        assert_eq!(result.message, Some(final_message));
        assert!(result.first_sse_at_ms.is_none());
        assert!(result.ended_at_ms >= result.started_at_ms);
        assert!(matches!(
            rx.recv().await.unwrap().event,
            GenerationEvent::ThinkingDelta { .. }
        ));
        assert_eq!(model.calls.load(Ordering::SeqCst), 1);
        assert_eq!(model.drops.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn eof_partial_failure_and_tools_never_succeed() {
    for events in [
        vec![GenerationEvent::TextDelta {
            content_index: 0,
            text: "partial".into(),
        }],
        vec![GenerationEvent::Failed {
            error: GenerationError::Failed("safe failure".into()),
            partial: Some(message(FinishReason::Error)),
        }],
        vec![GenerationEvent::Finished(message(FinishReason::ToolUse))],
        vec![GenerationEvent::BlockStarted {
            content_index: 0,
            block: ContentBlock::ToolCall {
                id: "call".into(),
                name: "tool".into(),
                arguments_json: None,
                thought_signature: None,
                namespace: None,
            },
        }],
    ] {
        let (tx, _rx) = mpsc::channel(8);
        let result = execute_text(request(), model(events), CancellationToken::new(), tx).await;
        assert_eq!(result.status, RunStatus::Failed);
        assert!(result.message.is_none());
        assert!(result.error.is_some());
    }
}

#[tokio::test]
async fn auxiliary_rejects_tool_content_even_with_a_stop_final_reason() {
    let mut final_message = message(FinishReason::Stop);
    final_message.content.push(ContentBlock::ToolCall {
        id: "call".into(),
        name: "tool".into(),
        arguments_json: Some("{}".into()),
        thought_signature: None,
        namespace: None,
    });
    let result = xw_agent_runtime::complete_text(
        request().generation,
        model(vec![GenerationEvent::Finished(final_message)]),
        CancellationToken::new(),
    )
    .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn cancellation_releases_opening_stream_and_blocked_internal_send() {
    for (opening, pending, count) in [(true, false, 0), (false, true, 1), (false, false, 10)] {
        let drops = Arc::new(AtomicUsize::new(0));
        let model = Arc::new(Model {
            events: (0..count)
                .map(|_| GenerationEvent::TextDelta {
                    content_index: 0,
                    text: "partial".into(),
                })
                .collect(),
            calls: AtomicUsize::new(0),
            drops: drops.clone(),
            opening,
            pending,
        });
        let cancellation = CancellationToken::new();
        let (tx, _rx) = mpsc::channel(1);
        let run = tokio::spawn(execute_text(request(), model.clone(), cancellation.clone(), tx));
        tokio::task::yield_now().await;
        cancellation.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), run)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.status, RunStatus::Cancelled);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    }
    let (tx, rx) = mpsc::channel(1);
    drop(rx);
    let m = model(vec![GenerationEvent::Finished(message(FinishReason::Stop))]);
    let outcome = execute_text(request(), m.clone(), CancellationToken::new(), tx).await;
    assert_eq!(outcome.status, RunStatus::Cancelled);
    assert_eq!(m.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cancellation_during_stream_poll_wins_over_eof_error_and_final_message() {
    struct CancelDuringPoll(Option<Result<GenerationEvent, GenerationError>>);

    impl LlmGeneration for CancelDuringPoll {
        fn generate(&self, _: GenerationRequest, cancellation: CancellationToken) -> GenerationFuture {
            let mut terminal = self.0.clone();
            Box::pin(async move {
                let partial = stream::iter([Ok(GenerationEvent::TextDelta {
                    content_index: 0,
                    text: "partial".into(),
                })]);
                let terminal = stream::poll_fn(move |_| {
                    // Cancel after the outer select has polled its cancellation branch.
                    cancellation.cancel();
                    std::task::Poll::Ready(terminal.take())
                });
                Ok(Box::pin(partial.chain(terminal)) as GenerationStream)
            })
        }
    }

    for terminal in [
        None,
        Some(Err(GenerationError::Failed("upstream closed".into()))),
        Some(Ok(GenerationEvent::Failed {
            error: GenerationError::Failed("provider failed".into()),
            partial: None,
        })),
        Some(Ok(GenerationEvent::Finished(message(FinishReason::Stop)))),
    ] {
        let (tx, mut rx) = mpsc::channel(8);
        let result = execute_text(
            request(),
            Arc::new(CancelDuringPoll(terminal.clone())),
            CancellationToken::new(),
            tx,
        )
        .await;

        assert_eq!(result.status, RunStatus::Cancelled, "terminal: {terminal:?}");
        assert!(matches!(result.error, Some(GenerationError::Cancelled)));
        assert!(result.message.is_none());
        assert_eq!(
            result.partial,
            vec![ContentBlock::Text {
                text: "partial".into(),
                signature: None,
            }],
        );
        assert!(matches!(
            rx.recv().await.unwrap().event,
            GenerationEvent::TextDelta { .. }
        ));
        assert!(rx.recv().await.is_none());
    }
}
