/// Service errors intentionally do not depend on transport error codes.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AgentError {
    #[error("invalid argument: {0}")]
    InvalidArgument(&'static str),
    #[error("not found: {0}")]
    NotFound(&'static str),
    #[error("conflict: {0}")]
    Conflict(&'static str),
    #[error("resource exhausted: {0}")]
    ResourceExhausted(&'static str),
    #[error("agent service closed")]
    Closed,
    #[error("text execution is not connected")]
    ExecutionUnavailable,
    #[error("会话已归档或正在关闭，请先取消归档后再操作")]
    SessionUnavailable,
    #[error("会话数据库操作失败，请检查磁盘空间及目录权限后重试")]
    Index,
    #[error("agent state unavailable")]
    Internal,
    #[error("会话记录写入或读取失败，请检查磁盘空间及目录权限后重新发送")]
    Persistence,
    #[error("{0}")]
    TitleGeneration(&'static str),
}
