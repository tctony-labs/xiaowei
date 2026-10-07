use std::{future::Future, pin::Pin, sync::Arc};

use crate::{CancellationToken, GenerationFuture, GenerationRequest};
use xw_agent_types::{AuxiliaryModelError, ModelInfo, ModelInfoError};

pub type ModelInfoFuture = Pin<Box<dyn Future<Output = Result<ModelInfo, ModelInfoError>> + Send>>;
pub type AuxiliaryModelRefFuture = Pin<Box<dyn Future<Output = Result<Option<String>, AuxiliaryModelError>> + Send>>;

/// Host-owned capabilities; no provider, settings or transport ownership crosses this interface.
pub trait AgentHost: Send + Sync {
    fn generate(&self, request: GenerationRequest, cancellation: CancellationToken) -> GenerationFuture;
    fn get_model_info(&self, model_ref: String) -> ModelInfoFuture;
    fn get_auxiliary_model_ref(&self) -> AuxiliaryModelRefFuture;
}

pub(crate) struct HostGeneration(pub Arc<dyn AgentHost>);

impl xw_agent_runtime::LlmGeneration for HostGeneration {
    fn generate(&self, request: GenerationRequest, cancellation: CancellationToken) -> GenerationFuture {
        self.0.generate(request, cancellation)
    }
}
