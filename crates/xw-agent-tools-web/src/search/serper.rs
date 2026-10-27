use serde::Deserialize;

use xw_agent_runtime::{CancellationToken, tools::ToolError};

use super::{SearchError, SearchFuture, SearchRequest, SearchResult, SearchTool};

const ENDPOINT: &str = "https://google.serper.dev/search";

pub struct SerperSearch {
    pub(super) client: reqwest::Client,
    api_key: String,
}

impl SerperSearch {
    #[cfg(test)]
    pub(crate) fn with_client(client: reqwest::Client, api_key: String) -> Self {
        Self { client, api_key }
    }

    pub fn new(api_key: String) -> Result<Self, ToolError> {
        Ok(Self {
            client: super::client(10)?,
            api_key,
        })
    }
}

#[derive(Deserialize)]
struct SerperResponse {
    #[serde(default)]
    organic: Vec<SerperHit>,
}

#[derive(Deserialize)]
struct SerperHit {
    #[serde(default)]
    title: String,
    #[serde(default)]
    link: String,
    #[serde(default)]
    snippet: String,
}

fn parse_response(body: &str) -> Result<Vec<SearchResult>, SearchError> {
    let resp: SerperResponse = serde_json::from_str(body).map_err(|_| SearchError::Parse)?;
    Ok(resp
        .organic
        .into_iter()
        .filter(|h| !h.link.is_empty() && !h.title.is_empty())
        .map(|h| SearchResult {
            title: h.title,
            url: h.link,
            snippet: h.snippet,
        })
        .collect())
}

impl SearchTool for SerperSearch {
    fn provider(&self) -> &'static str {
        "serper"
    }

    fn search(&self, request: SearchRequest, cancel: CancellationToken) -> SearchFuture<'_> {
        Box::pin(async move {
            let request = self
                .client
                .post(ENDPOINT)
                .header("X-API-KEY", &self.api_key)
                .json(&serde_json::json!({
                    "q": request.query,
                    "num": request.max_results.clamp(1, 20)
                }));
            let text = super::response_text(request, cancel, &[401, 403]).await?;
            parse_response(&text)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_response_maps_link_to_url() {
        let body = r#"{
            "organic": [
                { "title": "Tauri", "link": "https://tauri.app/", "snippet": "framework" },
                {
                    "title": "GitHub", "link": "https://github.com/tauri-apps/tauri",
                    "snippet": "build"
                }
            ]
        }"#;
        let r = parse_response(body).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].url, "https://tauri.app/");
        assert_eq!(r[0].title, "Tauri");
        assert_eq!(r[0].snippet, "framework");
    }

    #[test]
    fn parse_response_handles_missing_organic() {
        let r = parse_response(r#"{"searchParameters": {}}"#).unwrap();
        assert!(r.is_empty());
    }

    #[test]
    fn parse_response_skips_entries_missing_link() {
        let body = r#"{
            "organic": [
                { "title": "OK", "link": "", "snippet": "x" },
                { "title": "Real", "link": "https://r.com/", "snippet": "y" }
            ]
        }"#;
        let r = parse_response(body).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].url, "https://r.com/");
    }
}
