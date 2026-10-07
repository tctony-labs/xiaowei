//! Agent domain types and compact history validation, independent of host transports.

mod context;
mod format;
mod generation;
mod ids;
mod interaction;
mod message;
mod model;
mod rollout;
mod stored_json;
mod validation;

pub use context::{
    ContextBoundary, ExecutionPolicy, GenerationParameters, InputModality, InputMode, InputSource, ModelCapabilities,
    ModelDescriptor, RunCause, RunContext, RuntimeLimits, SourceKind, ToolDeclaration,
};

pub use format::{
    FormatError, HISTORY_VERSION, decode_deletion_marker, decode_entry, decode_history, encode_deletion_marker,
    encode_entry, encode_history,
};

pub use ids::{
    BlockId, ClientRequestId, EntryId, GenId, IdError, InputId, InteractionId, MessageId, MetadataRevision, RunId,
    Sequence, SessionId, ToolId, TurnId,
};

pub use interaction::{
    InteractionAnswer, InteractionExpireReason, InteractionExpired, InteractionOpened, InteractionRequest,
    InteractionResolved, PermissionTarget,
};

pub use message::{
    AgentMessage, AssistantMessage, ContentBlock, FinishReason, TokenUsage, ToolResultMessage, UsageCost, UserMessage,
};

pub use rollout::{
    Compacted, CompactionTrigger, ContextBudgetSnapshot, DeletionMarker, EntryPayload, GenEnded, GenFirstSseReceived,
    GenPurpose, GenStarted, GenStatus, InputAccepted, InputCancelReason, InputCancelled, InputConsumed, JournalEntry,
    MessageCompleteness, ProviderToolKey, RecordedMessage, RunEnd, RunStarted, RunStatus, SafeError, SessionMeta,
    SessionSummary, TitleSource, ToolIntent, ToolOutcome, ToolStatus, TurnEnded, TurnStarted, TurnStatus,
};

pub use validation::{ValidationCode, ValidationError, validate_entry, validate_history, validate_model_context};

pub use generation::{GenerationError, GenerationEvent, GenerationRequest};
pub use model::{
    AuxiliaryModelError, BudgetSource, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS, ModelBudget, ModelInfo,
    ModelInfoError, ModelSelection,
};
