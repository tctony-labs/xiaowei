use std::{collections::BTreeMap, future::Future, pin::Pin};

use xw_agent_types::ToolDeclaration;

use super::ToolOutput;
use crate::CancellationToken;

pub type ToolFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, ToolError>> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ToolError {
    #[error("{0}")]
    Failed(String),
    #[error("工具已取消")]
    Cancelled,
    /// A committed extraction lifecycle could not be saved. The Run must stop.
    #[error("工具生成记录写入失败")]
    CommitFailed,
}

impl From<String> for ToolError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryPolicy {
    ResultUnknown,
    CancelPending,
}

/// Capabilities provided by the owner of the Run and its committed history.
/// Implementations must propagate CommitFailed; it is not an ordinary tool error.
pub trait ToolContext: Send + Sync {
    fn cancellation(&self) -> CancellationToken;

    fn extract_text(&self, content: String, prompt: String) -> ToolFuture<'_, String>;
}

/// One logical tool. Configuration and transport ownership stay with the host.
pub trait AgentTool: Send + Sync {
    fn declaration(&self) -> ToolDeclaration;

    fn rules(&self) -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    fn recovery_policy(&self) -> RecoveryPolicy {
        RecoveryPolicy::ResultUnknown
    }

    fn execute<'a>(
        &'a self,
        arguments: &'a str,
        context: &'a dyn ToolContext,
    ) -> ToolFuture<'a, ToolOutput>;
}
