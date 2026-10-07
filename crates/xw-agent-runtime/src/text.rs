use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use tokio::sync::mpsc;
use xw_agent_types::{
    AssistantMessage, ContentBlock, FinishReason, GenId, InputId, MessageId, RunId, SessionId, TurnId,
};

use crate::{CancellationToken, GenerationError, GenerationEvent, GenerationRequest, LlmGeneration};

#[derive(Debug, Clone)]
pub struct RunRequest {
    pub session_id: SessionId,
    pub input_id: InputId,
    pub run_id: RunId,
    pub turn_id: TurnId,
    pub gen_id: GenId,
    pub message_id: MessageId,
    pub generation: GenerationRequest,
}

#[derive(Debug, Clone)]
pub struct RunEvent {
    pub run_id: RunId,
    pub gen_id: GenId,
    pub event: GenerationEvent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug)]
pub struct RunOutcome {
    pub status: RunStatus,
    pub message: Option<AssistantMessage>,
    pub partial: Vec<ContentBlock>,
    pub error: Option<GenerationError>,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    pub elapsed_ms: u64,
    pub first_sse_at_ms: Option<i64>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// One model generation, no retries or tool execution. The return value alone settles the run.
pub async fn execute_text(
    request: RunRequest,
    generation: Arc<dyn LlmGeneration>,
    cancellation: CancellationToken,
    events: mpsc::Sender<RunEvent>,
) -> RunOutcome {
    let started_at_ms = now_ms();
    let started = Instant::now();
    log::debug!(
        "Agent Gen started session={} input={} run={} turn={} gen={}",
        request.session_id,
        request.input_id,
        request.run_id,
        request.turn_id,
        request.gen_id
    );
    let mut first_sse_at_ms = None;
    let mut blocks = BTreeMap::<u32, ContentBlock>::new();
    let result = async {
        if cancellation.is_cancelled() || events.is_closed() {
            return Err(GenerationError::Cancelled);
        }
        let mut stream = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(GenerationError::Cancelled),
            _ = events.closed() => return Err(GenerationError::Cancelled),
            result = generation.generate(request.generation, cancellation.clone()) => result?,
        };
        loop {
            let event = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(GenerationError::Cancelled),
                _ = events.closed() => return Err(GenerationError::Cancelled),
                event = stream.next() => {
                    // Cancellation can arrive while the adapter is being polled and surface as EOF or an error.
                    if cancellation.is_cancelled() {
                        return Err(GenerationError::Cancelled);
                    }

                    event.ok_or_else(|| GenerationError::Failed(
                        "generation ended without a final message".into(),
                    ))??
                }
            };
            match &event {
                GenerationEvent::FirstSseReceived { received_at_ms } => {
                    if first_sse_at_ms.is_some() {
                        continue;
                    }
                    if *received_at_ms < 0 {
                        return Err(GenerationError::Failed("invalid SSE timestamp".into()));
                    }
                    first_sse_at_ms = Some(*received_at_ms);
                }
                GenerationEvent::Finished(message) => {
                    validate_final(message)?;
                    return Ok(message.clone());
                }
                GenerationEvent::Failed { error, partial } => {
                    if let Some(partial) = partial {
                        blocks = partial
                            .content
                            .iter()
                            .cloned()
                            .enumerate()
                            .map(|(i, b)| (i as u32, b))
                            .collect();
                    }
                    return Err(error.clone());
                }
                GenerationEvent::BlockStarted { content_index, block }
                | GenerationEvent::BlockFinished { content_index, block } => {
                    if !matches!(block, ContentBlock::Text { .. } | ContentBlock::Thinking { .. }) {
                        return Err(GenerationError::Failed(
                            "tools and images are not supported in text runs".into(),
                        ));
                    }
                    blocks.insert(*content_index, block.clone());
                }
                GenerationEvent::TextDelta { content_index, text } => {
                    let block = blocks.entry(*content_index).or_insert_with(|| ContentBlock::Text {
                        text: String::new(),
                        signature: None,
                    });
                    let ContentBlock::Text { text: accumulated, .. } = block else {
                        return Err(GenerationError::Failed("inconsistent text block".into()));
                    };
                    accumulated.push_str(text);
                }
                GenerationEvent::ThinkingDelta { content_index, text } => {
                    let block = blocks.entry(*content_index).or_insert_with(|| ContentBlock::Thinking {
                        text: String::new(),
                        signature: None,
                        redacted: false,
                    });
                    let ContentBlock::Thinking { text: accumulated, .. } = block else {
                        return Err(GenerationError::Failed("inconsistent thinking block".into()));
                    };
                    accumulated.push_str(text);
                }
                _ => {}
            }
            // Bound transient memory independently from transport queues.
            if blocks.len() > 1024 || blocks.values().map(block_bytes).sum::<usize>() > 1024 * 1024 {
                return Err(GenerationError::Failed("generation display budget exceeded".into()));
            }
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(GenerationError::Cancelled),
                result = events.send(RunEvent { run_id: request.run_id, gen_id: request.gen_id, event }) => {
                    result.map_err(|_| GenerationError::Cancelled)?;
                }
            }
        }
    }
    .await;
    // Also covers dropped opening futures and internally rejected model output.
    cancellation.cancel();
    let ended_at_ms = now_ms();
    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let (status, message, error) = match result {
        Ok(message) => (RunStatus::Completed, Some(message), None),
        Err(GenerationError::Cancelled) => (RunStatus::Cancelled, None, Some(GenerationError::Cancelled)),
        Err(error) => (RunStatus::Failed, None, Some(error)),
    };
    log::debug!(
        "Agent Gen settled run={} gen={} status={status:?} elapsed_ms={elapsed_ms}",
        request.run_id,
        request.gen_id
    );
    RunOutcome {
        status,
        message,
        error,
        partial: blocks.into_values().collect(),
        started_at_ms,
        ended_at_ms,
        elapsed_ms,
        first_sse_at_ms,
    }
}

fn block_bytes(block: &ContentBlock) -> usize {
    match block {
        ContentBlock::Text { text, .. } | ContentBlock::Thinking { text, .. } => text.len(),
        _ => usize::MAX,
    }
}

pub(crate) fn validate_final(message: &AssistantMessage) -> Result<(), GenerationError> {
    if !matches!(message.stop_reason, FinishReason::Stop | FinishReason::Length)
        || message.content.is_empty()
        || message
            .content
            .iter()
            .any(|block| !matches!(block, ContentBlock::Text { .. } | ContentBlock::Thinking { .. }))
        || message.content.iter().map(block_bytes).sum::<usize>() > 1024 * 1024
        || message.api.is_empty()
        || message.provider.is_empty()
        || message.model_id.is_empty()
    {
        return Err(GenerationError::Failed("unsupported or invalid final message".into()));
    }
    Ok(())
}
