use serde::{Deserialize, Serialize};

use crate::*;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InteractionOpened {
    pub interaction_id: InteractionId,
    pub revision: u64,
    pub run_id: RunId,
    pub tool_id: ToolId,
    pub request: InteractionRequest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PermissionTarget {
    pub path: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InteractionResolved {
    pub interaction_id: InteractionId,
    pub revision: u64,
    pub client_request_id: ClientRequestId,
    pub source: InputSource,
    pub answer: InteractionAnswer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InteractionExpired {
    pub interaction_id: InteractionId,
    pub revision: u64,
    pub reason: InteractionExpireReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preempting_input_id: Option<InputId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionExpireReason {
    Stopped,
    SessionClosing,
    Recovery,
    Preempted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case", deny_unknown_fields)]
pub enum InteractionRequest {
    Question {
        question: String,
        options: Vec<String>,
        multi_select: bool,
    },
    Permission {
        target: PermissionTarget,
        reason: String,
    },
    ToolExecution {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case", deny_unknown_fields)]
pub enum InteractionAnswer {
    Question {
        selected_indices: Vec<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    Permission {
        allow: bool,
    },
    ToolExecution {
        allow: bool,
    },
}
