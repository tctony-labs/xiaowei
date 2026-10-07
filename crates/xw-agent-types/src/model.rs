use serde::{Deserialize, Serialize};

use crate::ModelCapabilities;

pub const DEFAULT_CONTEXT_WINDOW: u64 = 256_000;
pub const DEFAULT_MAX_OUTPUT_TOKENS: u64 = 32_768;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelSelection {
    pub model_ref: String,
    pub reasoning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelInfo {
    pub model_ref: String,
    pub provider_name: String,
    pub model_name: String,
    pub capabilities: ModelCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ModelInfoError {
    #[error("model not found")]
    NotFound,
    #[error("model information unavailable")]
    Unavailable,
    #[error("invalid model information")]
    InvalidResponse,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AuxiliaryModelError {
    #[error("auxiliary model selection unavailable")]
    Unavailable,
    #[error("invalid auxiliary model reference")]
    InvalidResponse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelBudget {
    pub context_window: u64,
    pub max_output_tokens: u64,
    pub source: BudgetSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetSource {
    Host,
    Default,
}

impl Default for ModelBudget {
    fn default() -> Self {
        Self {
            context_window: DEFAULT_CONTEXT_WINDOW,
            max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
            source: BudgetSource::Default,
        }
    }
}
