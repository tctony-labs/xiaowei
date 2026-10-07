use std::{future::Future, pin::Pin};

use futures_util::Stream;
use tokio_util::sync::CancellationToken;
pub use xw_agent_types::{GenerationError, GenerationEvent, GenerationRequest};

pub type GenerationStream = Pin<Box<dyn Stream<Item = Result<GenerationEvent, GenerationError>> + Send>>;
pub type GenerationFuture = Pin<Box<dyn Future<Output = Result<GenerationStream, GenerationError>> + Send>>;

/// The adapter observes cancellation during opening and streaming, and cancels
/// upstream work when its future/stream is dropped. No transport types cross here.
pub trait LlmGeneration: Send + Sync {
    fn generate(&self, request: GenerationRequest, cancellation: CancellationToken) -> GenerationFuture;
}
