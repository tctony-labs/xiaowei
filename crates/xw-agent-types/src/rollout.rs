use serde::{Deserialize, Serialize};

use crate::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JournalEntry {
    pub schema_version: u32,
    pub session_id: SessionId,
    pub entry_id: EntryId,
    pub sequence: Sequence,
    pub timestamp_ms: i64,
    pub payload: EntryPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputAccepted {
    pub input_id: InputId,
    pub source: InputSource,
    pub mode: InputMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_run_id: Option<RunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_head: Option<EntryId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<ModelSelection>,
    pub message: RecordedMessage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputConsumed {
    pub input_ids: Vec<InputId>,
    pub run_id: RunId,
    pub turn_id: TurnId,
    pub boundary: ContextBoundary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputCancelled {
    pub input_id: InputId,
    pub reason: InputCancelReason,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunStarted {
    pub run_id: RunId,
    pub cause: RunCause,
    pub base_context: ContextBoundary,
    pub context: RunContext,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnStarted {
    pub turn_id: TurnId,
    pub run_id: RunId,
    pub ordinal: u32,
    pub boundary: ContextBoundary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnEnded {
    pub turn_id: TurnId,
    pub status: TurnStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_gen_id: Option<GenId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preempting_input_id: Option<InputId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<SafeError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenStarted {
    pub gen_id: GenId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub attempt: u32,
    pub purpose: GenPurpose,
    /// Auxiliary generations carry their own configuration; conversations inherit the Run context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<RunContext>,
    pub boundary: ContextBoundary,
    pub started_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenFirstSseReceived {
    pub gen_id: GenId,
    pub received_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenEnded {
    pub gen_id: GenId,
    pub status: GenStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preempting_input_id: Option<InputId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<FinishReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_message_id: Option<MessageId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<SafeError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedMessage {
    pub message_id: MessageId,
    pub block_ids: Vec<BlockId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gen_id: Option<GenId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<InputId>,
    pub completeness: MessageCompleteness,
    pub message: AgentMessage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SafeError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunEnd {
    pub run_id: RunId,
    pub status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<SafeError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub had_assistant_output: bool,
    pub tool_calls_used: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderToolKey {
    pub run_id: RunId,
    pub turn_id: TurnId,
    pub gen_id: GenId,
    pub provider_call_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolIntent {
    pub tool_id: ToolId,
    pub key: ProviderToolKey,
    pub assistant_message_id: MessageId,
    pub block_id: BlockId,
    pub tool_name: String,
    pub arguments_json: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolOutcome {
    pub tool_id: ToolId,
    pub key: ProviderToolKey,
    pub status: ToolStatus,
    pub result: RecordedMessage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<SafeError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled_by_run_id: Option<RunId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Compacted {
    pub gen_id: GenId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    pub boundary: ContextBoundary,
    pub replaced_through_entry_id: EntryId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept_from_entry_id: Option<EntryId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_checkpoint_id: Option<EntryId>,
    pub summary: String,
    pub replacement_history: Vec<AgentMessage>,
    pub trigger: CompactionTrigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_tokens_before: Option<u64>,
    pub context_window: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextBudgetSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_gen_end_id: Option<EntryId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_compaction_id: Option<EntryId>,
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSummary {
    pub session_id: SessionId,
    pub journal_relpath: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub title_source: TitleSource,
    pub archived: bool,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub committed_sequence: Sequence,
    pub metadata_revision: MetadataRevision,
    pub context: ContextBudgetSnapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeletionMarker {
    pub schema_version: u32,
    pub session_id: SessionId,
    pub journal_relpath: String,
    pub workspace_relpath: String,
    pub deleted_at_ms: i64,
    pub committed_sequence: Sequence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleSource {
    Untitled,
    Manual,
    Generated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputCancelReason {
    Recovery,
    SessionClosing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    Completed,
    Failed,
    Aborted,
    Interrupted,
    Preempted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GenStatus {
    Completed,
    Failed,
    Aborted,
    Interrupted,
    Preempted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageCompleteness {
    Complete,
    Partial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Completed,
    Aborted,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Completed,
    Failed,
    Cancelled,
    Skipped,
    ResultUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactionTrigger {
    AutoPreRun,
    AutoBetweenTurns,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum GenPurpose {
    Conversation,
    Compaction,
    Title,
    ToolExtraction { tool_id: ToolId },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case", deny_unknown_fields)]
pub enum EntryPayload {
    /// Immutable first record. Identity, version and creation time are in the envelope.
    SessionHeader,
    Meta(SessionMeta),
    InputAccepted(InputAccepted),
    InputConsumed(InputConsumed),
    InputCancelled(InputCancelled),
    RunStarted(RunStarted),
    TurnStarted(TurnStarted),
    TurnEnded(TurnEnded),
    GenStarted(GenStarted),
    GenFirstSseReceived(GenFirstSseReceived),
    GenEnded(GenEnded),
    Message(RecordedMessage),
    ToolIntent(ToolIntent),
    ToolOutcome(ToolOutcome),
    InteractionOpened(InteractionOpened),
    InteractionResolved(InteractionResolved),
    InteractionExpired(InteractionExpired),
    Compacted(Compacted),
    RunEnd(RunEnd),
}

impl<'de> Deserialize<'de> for GenPurpose {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct ToolData {
            tool_id: ToolId,
        }

        #[derive(Default)]
        enum Data {
            #[default]
            Missing,
            Null,
            Tool(ToolData),
        }

        impl<'de> Deserialize<'de> for Data {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                Option::<ToolData>::deserialize(deserializer).map(|tool| tool.map_or(Self::Null, Self::Tool))
            }
        }

        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            #[serde(rename = "type")]
            kind: String,
            #[serde(default)]
            data: Data,
        }

        let wire = Wire::deserialize(deserializer)?;
        if wire.kind == "tool_extraction" {
            let Data::Tool(tool) = wire.data else {
                return Err(serde::de::Error::custom("invalid purpose data"));
            };
            return Ok(Self::ToolExtraction { tool_id: tool.tool_id });
        }
        if !matches!(wire.data, Data::Missing) {
            return Err(serde::de::Error::custom("unexpected purpose data"));
        }
        match wire.kind.as_str() {
            "conversation" => Ok(Self::Conversation),
            "compaction" => Ok(Self::Compaction),
            "title" => Ok(Self::Title),
            _ => Err(serde::de::Error::custom("unknown generation purpose")),
        }
    }
}
