//! Transport-independent Agent App Server with an owned SQLite catalog and authoritative JSONL history.
mod catalog;
mod context;
mod context_sync;
mod error;
mod events;
mod execution;
mod host;
mod index;
mod input;
mod interaction_delivery;
mod interactive;
mod model;
mod persistence;
#[cfg(test)]
mod persistence_tests;
mod prompts;
mod recovery;
mod retention;
mod service;
mod session;
mod title;

pub use error::AgentError;
pub use events::{EventSubscription, SubscriptionError};
pub use interaction_delivery::InteractionSubscription;
pub use service::AgentService;
pub use xw_agent_runtime::{
    CancellationToken, GenerationError, GenerationEvent, GenerationFuture, GenerationRequest,
    GenerationStream, LlmGeneration,
};
pub use xw_agent_types::{InputSource, SourceKind};
pub use xw_contracts::xiaowei::agent as protocol;

pub use host::{AgentHost, AuxiliaryModelRefFuture, ModelInfoFuture};
pub use xw_agent_types::{AuxiliaryModelError, ModelInfo, ModelInfoError, ModelSelection};

pub use context::{RebuiltContext, rebuild_context};
pub use context_sync::{plan_system_context_update, sync_system_context};
pub use prompts::build_chat_system_context;
pub use recovery::{RecoveryState, inspect_recovery, settle_interrupted};

pub use retention::SessionViewing;

mod run_loop;
mod tool_registry;
mod workspace;
