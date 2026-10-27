use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};

use reqwest::{Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use serde_json::json;
use xw_agent_runtime::{
    CancellationToken,
    tools::{AgentTool, RecoveryPolicy, ToolContext, ToolError, ToolFuture, ToolOutput},
};
use xw_agent_types::ToolDeclaration;

mod bing;
mod brave;
mod serper;
mod tavily;

pub use bing::BingSearch;
pub use brave::BraveSearch;
pub use serper::SerperSearch;
pub use tavily::TavilySearch;

#[derive(Debug, Clone)]
pub struct SearchRequest {
    pub query: String,
    pub max_results: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchError {
    InvalidApiKey(u16),
    QuotaExceeded(u16),
    Upstream(u16),
    Network,
    Timeout,
    Parse,
    Cancelled,
}

impl std::fmt::Display for SearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidApiKey(status) => write!(f, "API Key 无效 (HTTP {status})"),
            Self::QuotaExceeded(status) => write!(f, "搜索额度或频率受限 (HTTP {status})"),
            Self::Upstream(status) => write!(f, "搜索服务错误 (HTTP {status})"),
            Self::Network => f.write_str("搜索网络请求失败"),
            Self::Timeout => f.write_str("搜索请求超时"),
            Self::Parse => f.write_str("搜索响应格式无效"),
            Self::Cancelled => f.write_str("搜索已取消"),
        }
    }
}

impl std::error::Error for SearchError {}

pub type SearchFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Vec<SearchResult>, SearchError>> + Send + 'a>>;

/// A single provider, holding only its own client and constructor-supplied key.
pub trait SearchTool: Send + Sync {
    fn provider(&self) -> &'static str;

    fn search(&self, request: SearchRequest, cancellation: CancellationToken) -> SearchFuture<'_>;
}

pub struct WebSearch {
    provider: RwLock<Arc<dyn SearchTool>>,
}

impl WebSearch {
    pub fn new(search: Arc<dyn SearchTool>) -> Self {
        Self {
            provider: RwLock::new(search),
        }
    }

    pub fn set_provider(&self, search: Arc<dyn SearchTool>) {
        *self.provider.write().expect("search provider lock") = search;
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    query: String,
    max_results: Option<u64>,
}

impl AgentTool for WebSearch {
    fn declaration(&self) -> ToolDeclaration {
        ToolDeclaration {
            name: "WebSearch".into(),
            description: concat!(
                "Search the web and return ordered titles, URLs and snippets. ",
                "Use focused queries, prefer English keywords for technical topics. ",
                "Search sequentially and refine unhelpful queries. ",
                "Use WebFetch for a known URL. Usually stop after 2–3 searches per task.",
            )
            .into(),
            parameters_json: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Focused search query"},
                    "max_results": {
                        "type": "integer", "description": "Default 10, limited to 1–20"
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            })
            .to_string(),
            constrained_sampling_json: None,
        }
    }

    fn rules(&self) -> BTreeMap<String, String> {
        BTreeMap::from([(
            "tool.WebSearch".into(),
            "搜索应聚焦问题，技术主题优先英文关键词；逐次搜索、阅读结果后再决定。\
             结果不佳时改进关键词、site: 或范围，不重复相近查询。已知 URL 使用 WebFetch。\
             不搜索已知或可推导的信息；每任务通常搜索 2–3 次，仍无有效结果时向用户说明。"
                .into(),
        )])
    }

    fn recovery_policy(&self) -> RecoveryPolicy {
        RecoveryPolicy::CancelPending
    }

    fn execute<'a>(
        &'a self,
        arguments: &'a str,
        context: &'a dyn ToolContext,
    ) -> ToolFuture<'a, ToolOutput> {
        Box::pin(async move {
            let args: Arguments = serde_json::from_str(arguments)
                .map_err(|_| ToolError::Failed("WebSearch 参数无效".into()))?;
            let query = args.query.trim().to_owned();
            if query.is_empty() {
                return Err(ToolError::Failed("query 不能为空".into()));
            }
            let max_results = args.max_results.unwrap_or(10).clamp(1, 20) as usize;
            let provider = self.provider.read().expect("search provider lock").clone();
            let started = Instant::now();
            let response = provider
                .search(
                    SearchRequest {
                        query: query.clone(),
                        max_results,
                    },
                    context.cancellation(),
                )
                .await;
            let mut results = response.map_err(|error| {
                log::debug!(
                    "WebSearch failed provider={} error={error}",
                    provider.provider()
                );
                if error == SearchError::Cancelled {
                    ToolError::Cancelled
                } else {
                    ToolError::Failed(format!("WebSearch: {error}"))
                }
            })?;
            results.truncate(max_results);
            log::debug!(
                "WebSearch settled provider={} results={} duration_ms={}",
                provider.provider(),
                results.len(),
                started.elapsed().as_millis()
            );
            let mut text = if results.is_empty() {
                format!("No results for query: {query}")
            } else {
                format!("Search results for: {query}\n\n")
            };
            for (index, result) in results.iter().enumerate() {
                text.push_str(&format!(
                    "{}. {}\n   {}\n   {}\n\n",
                    index + 1,
                    result.title,
                    result.url,
                    result.snippet
                ));
            }
            Ok(ToolOutput {
                text,
                metadata_json: Some(
                    json!({"webSearch": {
                        "query": query, "provider": provider.provider(), "results": results
                    }})
                    .to_string(),
                ),
            })
        })
    }
}

fn client(redirects: usize) -> Result<Client, ToolError> {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(redirects))
        .build()
        .map_err(|_| ToolError::Failed("无法创建搜索客户端".into()))
}

fn network_error(error: reqwest::Error) -> SearchError {
    if error.is_timeout() {
        SearchError::Timeout
    } else {
        SearchError::Network
    }
}

async fn response_text(
    request: RequestBuilder,
    cancel: CancellationToken,
    invalid_statuses: &[u16],
) -> Result<String, SearchError> {
    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(SearchError::Cancelled),
        result = request.send() => result.map_err(network_error)?,
    };
    let status = response.status().as_u16();
    if invalid_statuses.contains(&status) {
        return Err(SearchError::InvalidApiKey(status));
    }
    if status == 429 {
        return Err(SearchError::QuotaExceeded(status));
    }
    if status != 200 {
        return Err(SearchError::Upstream(status));
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(SearchError::Cancelled),
        result = response.text() => result.map_err(network_error),
    }
}
