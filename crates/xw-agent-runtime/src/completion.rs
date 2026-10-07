use std::{sync::Arc, time::Instant};

use futures_util::StreamExt;
use xw_agent_types::{AssistantMessage, ContentBlock, GenId};

use crate::{CancellationToken, GenerationError, GenerationEvent, GenerationRequest, LlmGeneration};

/// Consume the same streaming interface for auxiliary text tasks. Only a valid
/// successful final message is returned; deltas never stand in for completion.
pub async fn complete_text(
    request: GenerationRequest,
    generation: Arc<dyn LlmGeneration>,
    cancellation: CancellationToken,
) -> Result<AssistantMessage, GenerationError> {
    let gen_id = GenId::new();
    let session_id = request.session_id;
    let started = Instant::now();
    log::debug!("Agent auxiliary Gen started session={session_id} gen={gen_id}");
    let _cancel = cancellation.clone().drop_guard();
    let result = async {
        let mut stream = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(GenerationError::Cancelled),
            result = generation.generate(request, cancellation.clone()) => result?,
        };
        loop {
            let event = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(GenerationError::Cancelled),
                event = stream.next() => event.ok_or_else(|| GenerationError::Failed(
                    "generation ended without a final message".into(),
                ))??,
            };
            match event {
                GenerationEvent::Finished(message) => {
                    crate::text::validate_final(&message)?;
                    return Ok(message);
                }
                GenerationEvent::Failed { error, .. } => return Err(error),
                GenerationEvent::BlockStarted { block, .. } | GenerationEvent::BlockFinished { block, .. }
                    if !matches!(block, ContentBlock::Text { .. } | ContentBlock::Thinking { .. }) =>
                {
                    return Err(GenerationError::Failed("unsupported auxiliary output".into()));
                }
                _ => {}
            }
        }
    }
    .await;
    log::debug!(
        "Agent auxiliary Gen settled session={session_id} gen={gen_id} success={} elapsed_ms={}",
        result.is_ok(),
        started.elapsed().as_millis()
    );
    result
}
