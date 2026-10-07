use serde::{Deserialize, Serialize};

use crate::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunContext {
    pub model: ModelDescriptor,
    pub generation: GenerationParameters,
    pub tools: Vec<ToolDeclaration>,
    pub limits: RuntimeLimits,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelDescriptor {
    /// Opaque host reference; resolving the provider and upstream model belongs to the adapter.
    pub model_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    /// None means capability lookup failed, not that input / reasoning is unsupported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ModelCapabilities>,
    pub budget: ModelBudget,
}

/// Provider-independent capabilities used for input validation and context budgeting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelCapabilities {
    pub input_modalities: Vec<InputModality>,
    pub supports_reasoning: bool,
    pub context_window: u64,
    pub max_output_tokens: u64,
}

/// Effective generation settings retained for replay; provider-specific semantics belong to the adapter.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenerationParameters {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_budgets_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampling_params_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_retention: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub websocket_connect_timeout_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_options_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolDeclaration {
    pub name: String,
    pub description: String,
    pub parameters_json: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constrained_sampling_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_gens: Option<u32>,
    pub max_tool_calls: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputSource {
    pub kind: SourceKind,
    pub principal_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextBoundary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub through_entry_id: Option<EntryId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_turn_id: Option<TurnId>,
}

/// An accepted input modality. Actual text and image payloads are represented by `ContentBlock`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputModality {
    Text,
    Image,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Desktop,
    Cli,
    Remote,
    Internal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputMode {
    Send,
    FollowUp,
    Steering,
    Preempt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPolicy {
    Interactive,
    UnattendedWorkspace,
    Unrestricted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case", deny_unknown_fields)]
pub enum RunCause {
    Send {
        input_id: InputId,
    },
    FollowUp {
        input_ids: Vec<InputId>,
    },
    Continue {
        previous_run_id: RunId,
        client_request_id: ClientRequestId,
        source: InputSource,
    },
}
