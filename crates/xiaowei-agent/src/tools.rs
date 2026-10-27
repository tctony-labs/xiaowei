use std::sync::Arc;

use prost::{Message, Name};
use proto_desktop_rs::xiaowei::desktop::{
    GetWebSearchRuntimeConfigRequest, SettingsChanged, WebSearchProvider,
    WebSearchProviderTestResult, WebSearchRuntimeConfig,
};
use tokio::{sync::watch, task::JoinHandle};
use xw_agent::{AgentService, CancellationToken, ToolRegistration};
use xw_agent_tools_web::{
    BingSearch, BraveSearch, SearchRequest, SearchTool, SerperSearch, TavilySearch, WebFetch,
    WebSearch,
};
use xw_gateway::{Client, ErrorCode, GatewayError, event::EventSubscription};

use crate::gateway_binding::xiaowei_desktop_settings_service as settings;

#[derive(Debug, thiserror::Error)]
pub enum ToolAssemblyError {
    #[error("Search provider configuration is invalid")]
    InvalidConfiguration,
    #[error("Search settings read failed")]
    ReadConfiguration,
    #[error("请先保存该搜索源的 API Key，并确认搜索源选择有效")]
    MissingConfiguration,
    #[error("Web tool creation failed: {0}")]
    Creation(xw_agent::ToolError),
}

/// The only provider selection point. Each constructor receives just its own key.
pub fn create_search_tool(
    config: &WebSearchRuntimeConfig,
) -> Result<Arc<dyn SearchTool>, ToolAssemblyError> {
    let key = || {
        config
            .api_key
            .clone()
            .filter(|value| !value.is_empty())
            .ok_or(ToolAssemblyError::InvalidConfiguration)
    };
    let tool: Arc<dyn SearchTool> = match WebSearchProvider::try_from(config.provider) {
        Ok(WebSearchProvider::Bing) => {
            Arc::new(BingSearch::new().map_err(ToolAssemblyError::Creation)?)
        }
        Ok(WebSearchProvider::Tavily) => {
            Arc::new(TavilySearch::new(key()?).map_err(ToolAssemblyError::Creation)?)
        }
        Ok(WebSearchProvider::Brave) => {
            Arc::new(BraveSearch::new(key()?).map_err(ToolAssemblyError::Creation)?)
        }
        Ok(WebSearchProvider::Serper) => {
            Arc::new(SerperSearch::new(key()?).map_err(ToolAssemblyError::Creation)?)
        }
        _ => return Err(ToolAssemblyError::InvalidConfiguration),
    };
    Ok(tool)
}

pub(crate) struct ToolAssembly {
    cancel: CancellationToken,
    subscription: EventSubscription,
    task: JoinHandle<()>,
    client: Client,
}

async fn read_config(
    client: &Client,
    provider: Option<i32>,
    cancel: &CancellationToken,
) -> Result<WebSearchRuntimeConfig, ToolAssemblyError> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(ToolAssemblyError::ReadConfiguration),
        value = settings::GET_WEB_SEARCH_RUNTIME_CONFIG.call(client,
            GetWebSearchRuntimeConfigRequest { provider }) => {
            value.map_err(|error| if error.code == ErrorCode::InvalidArgument {
                ToolAssemblyError::MissingConfiguration
            } else {
                ToolAssemblyError::ReadConfiguration
            })
        }
    }
}

impl ToolAssembly {
    pub async fn start(
        service: &AgentService,
        client: Client,
        cancel: CancellationToken,
    ) -> Result<Self, GatewayError> {
        // A watch notification is only a wake-up. Even identical redacted snapshots
        // must trigger a new read, since the saved key may have changed.
        let (updates, mut values) = watch::channel(0u64);
        let subscription = client
            .subscribe(&SettingsChanged::full_name(), None, false, move |bytes| {
                let updates = updates.clone();
                async move {
                    if SettingsChanged::decode(bytes.as_slice()).is_ok() {
                        updates.send_modify(|version| *version = version.wrapping_add(1));
                    } else {
                        log::error!("Agent search settings notification decode failed");
                    }
                }
            })
            .await?;
        let prepared = async {
            let config = read_config(&client, None, &cancel).await?;
            let search = Arc::new(WebSearch::new(create_search_tool(&config)?));
            let fetch = WebFetch::new().map_err(ToolAssemblyError::Creation)?;
            Ok::<_, ToolAssemblyError>((config, search, fetch))
        }
        .await;
        let (mut current, search, fetch) = match prepared {
            Ok(value) => value,
            Err(error) => {
                subscription.close();
                return Err(GatewayError::new(
                    ErrorCode::HandlerError,
                    error.to_string(),
                ));
            }
        };
        if let Err(error) = service.set_tools(vec![
            ToolRegistration::new("web.fetch", Arc::new(fetch)),
            ToolRegistration::new("web.search", search.clone()),
        ]) {
            subscription.close();
            return Err(crate::gateway::error(error));
        }
        log::debug!("Agent web tools assembled provider={}", current.provider);
        let task_client = client.clone();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = task_cancel.cancelled() => break,
                    update = values.changed() => {
                        if update.is_err() { break; }
                        values.borrow_and_update();
                        let config = match read_config(&task_client, None, &task_cancel).await {
                            Ok(config) => config,
                            Err(error) => {
                                if !task_cancel.is_cancelled() {
                                    log::error!("Agent search refresh stage=read error={error}");
                                }
                                continue;
                            }
                        };
                        if config == current { continue; }
                        match create_search_tool(&config) {
                            Ok(provider) => {
                                if task_cancel.is_cancelled() { break; }
                                search.set_provider(provider);
                                log::debug!(
                                    "Agent search provider refreshed provider={}", config.provider
                                );
                                current = config;
                            }
                            Err(error) => log::error!(
                                "Agent search refresh stage=create provider={} error={error}",
                                config.provider
                            ),
                        }
                    }
                }
            }
        });
        Ok(Self {
            cancel,
            subscription,
            task,
            client,
        })
    }

    pub fn cancel(&self) {
        self.subscription.close();
        self.cancel.cancel();
    }

    pub async fn close(self) {
        self.cancel();
        let _ = self.task.await;
    }

    pub fn test_client(&self) -> (Client, CancellationToken) {
        (self.client.clone(), self.cancel.child_token())
    }
}

pub(crate) async fn test_provider(
    client: Client,
    provider: i32,
    cancel: CancellationToken,
) -> WebSearchProviderTestResult {
    let started = std::time::Instant::now();
    let result = async {
        let config = read_config(&client, Some(provider), &cancel)
            .await
            .map_err(|error| error.to_string())?;
        let tool = create_search_tool(&config).map_err(|error| error.to_string())?;
        tool.search(
            SearchRequest {
                query: "ping".into(),
                max_results: 1,
            },
            cancel,
        )
        .await
        .map_err(|error| error.to_string())
    }
    .await;
    WebSearchProviderTestResult {
        ok: result.is_ok(),
        latency_ms: started.elapsed().as_millis().min(u32::MAX as u128) as u32,
        sample_title: result
            .as_ref()
            .ok()
            .and_then(|results| results.first())
            .map(|result| result.title.clone()),
        error: result.err(),
    }
}
