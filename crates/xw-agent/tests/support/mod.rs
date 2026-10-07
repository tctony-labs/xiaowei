use futures_util::FutureExt;
use std::sync::Arc;

use xw_agent::{
    AgentHost, AgentService, CancellationToken, GenerationFuture, GenerationRequest,
    protocol::{AgentModelConfig, AgentSession, CreateSessionRequest},
};
use xw_agent_types::ClientRequestId;

struct NeverGenerate;

impl AgentHost for NeverGenerate {
    fn get_model_info(&self, model_ref: String) -> xw_agent::ModelInfoFuture {
        Box::pin(async move {
            Ok(xw_agent::ModelInfo {
                model_ref,
                provider_name: "fixture".into(),
                model_name: "test".into(),
                capabilities: xw_agent_types::ModelCapabilities {
                    input_modalities: vec![xw_agent_types::InputModality::Text],
                    supports_reasoning: true,
                    context_window: 256_000,
                    max_output_tokens: 32_768,
                },
            })
        })
    }

    fn get_auxiliary_model_ref(&self) -> xw_agent::AuxiliaryModelRefFuture {
        Box::pin(async { Ok(None) })
    }

    fn generate(&self, _: GenerationRequest, _: CancellationToken) -> GenerationFuture {
        panic!("metadata tests must not start generation")
    }
}

pub fn service() -> AgentService {
    AgentService::new(Arc::new(NeverGenerate))
}

pub fn create(service: &AgentService) -> AgentSession {
    service
        .create_session(CreateSessionRequest {
            title_model_ref: String::new(),
            client_request_id: ClientRequestId::new().to_string(),
            config: Some(config()),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap()
        .session
        .unwrap()
}

pub fn config() -> AgentModelConfig {
    AgentModelConfig {
        model_ref: "test-model".into(),
        reasoning: Some("high".into()),
    }
}
