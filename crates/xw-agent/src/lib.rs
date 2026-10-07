//! Transport-independent Agent App Server with an owned SQLite catalog and authoritative JSONL history.
mod catalog;
mod context;
mod error;
mod events;
mod execution;
mod host;
mod index;
mod input;
mod model;
mod persistence;
#[cfg(test)]
mod persistence_tests;
mod recovery;
mod retention;
mod service;
mod session;
mod title;

pub use error::AgentError;
pub use events::{EventSubscription, SubscriptionError};
pub use service::AgentService;
pub use xw_agent_runtime::{
    CancellationToken, GenerationError, GenerationEvent, GenerationFuture, GenerationRequest, GenerationStream,
    LlmGeneration,
};
pub use xw_agent_types::{InputSource, SourceKind};
pub use xw_contracts::xiaowei::agent as protocol;

pub use host::{AgentHost, AuxiliaryModelRefFuture, ModelInfoFuture};
pub use xw_agent_types::{AuxiliaryModelError, ModelInfo, ModelInfoError, ModelSelection};

pub use context::{RebuiltContext, rebuild_context};
pub use recovery::{RecoveryState, inspect_recovery, settle_interrupted};

pub use retention::SessionViewing;
