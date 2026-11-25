//! Model generation boundary. Execution is implemented separately from the App Server protocol.
pub mod compact;
mod completion;
pub mod context_budget;
mod generation;

pub use completion::complete_text;

pub use generation::{
    GenerationError, GenerationEvent, GenerationFuture, GenerationRequest, GenerationStream,
    LlmGeneration,
};
pub use tokio_util::sync::CancellationToken;
mod text;
pub use text::{RunEvent, RunOutcome, RunRequest, RunStatus, execute_text};

mod permission;
pub mod resources;
pub mod tools;
