use napi_derive::napi;
use std::sync::{Mutex, OnceLock};
use xiaowei_search::{Action, SearchEngine};

pub mod logging;

static ENGINE: OnceLock<Mutex<SearchEngine>> = OnceLock::new();

#[napi(object)]
pub struct HighlightRange {
    pub start: u32,
    pub end: u32,
}

#[napi(object)]
pub struct SearchHit {
    pub id: String,
    pub recency_key: String,
    pub title: String,
    pub provider: String,
    pub label: String,
    pub score: f64,
    pub ranges: Vec<HighlightRange>,
    pub action_type: String,
    pub action_value: String,
}

#[napi]
pub async fn search(query: String, development: Option<bool>) -> napi::Result<Vec<SearchHit>> {
    if query.len() > 4096 {
        return Err(napi::Error::from_reason("Search query is too long"));
    }
    napi::tokio::task::spawn_blocking(move || {
        let engine = ENGINE.get_or_init(|| Mutex::new(SearchEngine::open_default()));
        let engine = engine
            .lock()
            .map_err(|_| napi::Error::from_reason("Search engine unavailable"))?;
        Ok(engine
            .search_with_development(&query, development.unwrap_or(false))
            .into_iter()
            .map(|hit| {
                let (kind, value) = match hit.action {
                    Action::CopyText(value) => ("copyText", value),
                    Action::OpenUrl(value) => ("openUrl", value),
                    Action::LaunchApp(value) => ("launchApp", value),
                    Action::RunCommand(value) => ("runCommand", value),
                };
                SearchHit {
                    id: hit.id,
                    recency_key: hit.recency_key,
                    title: hit.title,
                    provider: hit.provider,
                    label: hit.label,
                    score: hit.score as f64,
                    ranges: hit
                        .ranges
                        .into_iter()
                        .map(|[start, end]| HighlightRange { start, end })
                        .collect(),
                    action_type: kind.into(),
                    action_value: value,
                }
            })
            .collect())
    })
    .await
    .map_err(|error| napi::Error::from_reason(error.to_string()))?
}

#[napi]
pub fn record_usage(id: String) -> napi::Result<()> {
    if let Some(engine) = ENGINE.get() {
        engine
            .lock()
            .map_err(|_| napi::Error::from_reason("Search engine unavailable"))?
            .record_usage(&id);
    }
    Ok(())
}

#[napi]
pub async fn read_app_icon(path: String) -> napi::Result<Option<napi::bindgen_prelude::Buffer>> {
    napi::tokio::task::spawn_blocking(move || {
        xiaowei_search::read_app_icon(std::path::Path::new(&path)).map(Into::into)
    })
    .await
    .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub async fn toggle_system_theme() -> napi::Result<bool> {
    napi::tokio::task::spawn_blocking(xiaowei_search::toggle_dark_mode)
        .await
        .map_err(|error| napi::Error::from_reason(error.to_string()))?
        .map_err(napi::Error::from_reason)
}
