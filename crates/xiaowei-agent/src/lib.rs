//! Gateway integration; the core owns sessions and the worker owns model configuration.
pub mod gateway;
#[allow(dead_code)]
mod gateway_binding;
mod generation;
pub mod message_codec;
pub mod tools;

use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use xw_agent::{AgentError, AgentService};
use xw_gateway::Client;

pub struct Agent {
    pub service: Arc<AgentService>,
    generation: Arc<generation::GatewayGeneration>,
    tools: Mutex<Option<tools::ToolAssembly>>,
    cancel: xw_agent::CancellationToken,
    ready: AtomicBool,
}

impl Agent {
    pub fn new() -> Arc<Self> {
        let generation = Arc::new(generation::GatewayGeneration::default());
        Arc::new(Self {
            service: Arc::new(AgentService::new(generation.clone())),
            generation,
            tools: Mutex::new(None),
            cancel: xw_agent::CancellationToken::new(),
            ready: AtomicBool::new(false),
        })
    }

    pub async fn open(root: PathBuf) -> Result<Arc<Self>, AgentError> {
        let generation = Arc::new(generation::GatewayGeneration::default());
        let service = AgentService::open(generation.clone(), root).await?;
        Ok(Arc::new(Self {
            service: Arc::new(service),
            generation,
            tools: Mutex::new(None),
            cancel: xw_agent::CancellationToken::new(),
            ready: AtomicBool::new(false),
        }))
    }

    pub async fn activate(
        self: &Arc<Self>,
        client: Client,
    ) -> Result<(), xw_gateway::GatewayError> {
        let assembly =
            tools::ToolAssembly::start(&self.service, client.clone(), self.cancel.clone()).await?;
        {
            let mut tools = self.tools.lock().unwrap();
            if !self.cancel.is_cancelled() {
                *tools = Some(assembly);
                self.generation.bind(client);
                self.ready.store(true, Ordering::Release);
                self.service.start_maintenance();
                return Ok(());
            }
        }
        assembly.close().await;
        Err(xw_gateway::GatewayError::new(
            xw_gateway::ErrorCode::OwnerUnavailable,
            "Agent closed",
        ))
    }
    pub fn ready(&self) -> bool {
        self.ready.load(Ordering::Acquire) && self.generation.ready()
    }

    pub fn cancel(&self) {
        let tools = self.tools.lock().unwrap();
        self.ready.store(false, Ordering::Release);
        self.cancel.cancel();
        if let Some(tools) = tools.as_ref() {
            tools.cancel();
        }
        self.service.cancel_all();
        self.generation.clear();
    }

    pub async fn close(&self) -> Result<(), AgentError> {
        let tools = {
            let mut tools = self.tools.lock().unwrap();
            self.ready.store(false, Ordering::Release);
            self.cancel.cancel();
            tools.take()
        };
        if let Some(tools) = tools {
            tools.close().await;
        }
        let result = self.service.close().await;
        self.generation.clear();
        result
    }

    pub async fn test_web_search_provider(
        &self,
        provider: i32,
    ) -> Result<
        proto_desktop_rs::xiaowei::desktop::WebSearchProviderTestResult,
        xw_gateway::GatewayError,
    > {
        let (client, cancel) = self
            .tools
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(|| {
                xw_gateway::GatewayError::new(
                    xw_gateway::ErrorCode::OwnerUnavailable,
                    "Agent inactive",
                )
            })?
            .test_client();
        Ok(tools::test_provider(client, provider, cancel).await)
    }
}
