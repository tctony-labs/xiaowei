//! Gateway integration; the core owns sessions and the worker owns model configuration.
pub mod gateway;
#[allow(dead_code)]
mod gateway_binding;
mod generation;
pub mod message_codec;

use std::{path::PathBuf, sync::Arc};
use xw_agent::{AgentError, AgentService};
use xw_gateway::Client;

pub struct Agent {
    pub service: Arc<AgentService>,
    generation: Arc<generation::GatewayGeneration>,
}

impl Agent {
    pub fn new() -> Arc<Self> {
        let generation = Arc::new(generation::GatewayGeneration::default());
        Arc::new(Self {
            service: Arc::new(AgentService::new(generation.clone())),
            generation,
        })
    }

    pub async fn open(root: PathBuf) -> Result<Arc<Self>, AgentError> {
        let generation = Arc::new(generation::GatewayGeneration::default());
        let service = AgentService::open(generation.clone(), root).await?;
        Ok(Arc::new(Self {
            service: Arc::new(service),
            generation,
        }))
    }

    pub fn activate(self: &Arc<Self>, client: Client) {
        self.generation.bind(client);
        self.service.start_maintenance();
    }
    pub fn ready(&self) -> bool {
        self.generation.ready()
    }

    pub fn cancel(&self) {
        self.service.cancel_all();
        self.generation.clear();
    }

    pub async fn close(&self) -> Result<(), AgentError> {
        let result = self.service.close().await;
        self.generation.clear();
        result
    }
}
