//! JSONL ownership, durable append and tail repair. No Agent execution or recovery decisions.
mod local;
mod recovery;
mod writer_lock;

pub use local::{Journal, RolloutStore, SessionFiles, WriterState};
pub use recovery::Repair;

#[cfg(feature = "test-support")]
#[doc(hidden)]
pub use local::TestFault;

#[derive(Debug, thiserror::Error)]
pub enum RolloutError {
    #[error("rollout writer is already owned")]
    Busy,
    #[error("rollout requires validation after a failed write")]
    NeedsCheck,
    #[error("invalid rollout history")]
    InvalidHistory,
    #[error("rollout validation failed: {0}")]
    Validation(#[from] xw_agent_types::ValidationError),
    #[error("unsupported rollout version")]
    UnsupportedVersion,
    #[error("rollout I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, RolloutError>;
