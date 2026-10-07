use crate::{AgentMessage, AssistantMessage, ContentBlock, SessionId, TokenUsage};

/// Per-call values, not persisted configuration or provider registration.
#[derive(Debug, Clone)]
pub struct GenerationRequest {
    pub session_id: SessionId,
    pub model_ref: String,
    pub system_prompt: String,
    pub messages: Vec<AgentMessage>,
    pub reasoning: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone)]
pub enum GenerationEvent {
    Started,
    FirstSseReceived {
        received_at_ms: i64,
    },
    BlockStarted {
        content_index: u32,
        block: ContentBlock,
    },
    TextDelta {
        content_index: u32,
        text: String,
    },
    ThinkingDelta {
        content_index: u32,
        text: String,
    },
    BlockFinished {
        content_index: u32,
        block: ContentBlock,
    },
    Usage(TokenUsage),
    Finished(AssistantMessage),
    Failed {
        error: GenerationError,
        partial: Option<AssistantMessage>,
    },
}

/// Adapters must only supply public diagnostics, never upstream bodies or credentials.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GenerationError {
    #[error("generation cancelled")]
    Cancelled,
    #[error("generation unavailable")]
    Unavailable,
    #[error("{0}")]
    Failed(String),
}
