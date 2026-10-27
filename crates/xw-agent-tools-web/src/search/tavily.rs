use serde::Deserialize;

use xw_agent_runtime::{CancellationToken, tools::ToolError};

use super::{SearchError, SearchFuture, SearchRequest, SearchResult, SearchTool};

const ENDPOINT: &str = "https://api.tavily.com/search";

pub struct TavilySearch {
    pub(super) client: reqwest::Client,
    api_key: String,
}

impl TavilySearch {
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
struct TavilyResponse {
    #[serde(default)]
    results: Vec<TavilyHit>,
}

#[derive(Deserialize)]
struct TavilyHit {
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    content: String,
}

fn parse_response(body: &str) -> Result<Vec<SearchResult>, SearchError> {
    let resp: TavilyResponse = serde_json::from_str(body).map_err(|_| SearchError::Parse)?;
    Ok(resp
        .results
        .into_iter()
        .filter(|h| !h.url.is_empty() && !h.title.is_empty())
        .map(|h| SearchResult {
            title: h.title,
            url: h.url,
            snippet: h.content,
        })
        .collect())
}

impl SearchTool for TavilySearch {
    fn provider(&self) -> &'static str {
        "tavily"
    }

    fn search(&self, request: SearchRequest, cancel: CancellationToken) -> SearchFuture<'_> {
        Box::pin(async move {
            let request = self.client.post(ENDPOINT).json(&serde_json::json!({
                "api_key": self.api_key,
                "query": request.query,
                "search_depth": "basic",
                "max_results": request.max_results.clamp(1, 20),
                "include_answer": false,
                "include_raw_content": false
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
    fn parse_response_extracts_results() {
        let body = r#"{
            "query": "test",
            "results": [
                {
                    "title": "The Rust Programming Language",
                    "url": "https://www.rust-lang.org/",
                    "content": "A language empowering everyone to build reliable software.",
                    "score": 0.9
                },
                {
                    "title": "Rust on GitHub",
                    "url": "https://github.com/rust-lang/rust",
                    "content": "Empowering everyone."
                }
            ]
        }"#;
        let r = parse_response(body).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].title, "The Rust Programming Language");
        assert_eq!(r[0].url, "https://www.rust-lang.org/");
        assert!(r[0].snippet.contains("reliable"));
    }

    #[test]
    fn parse_response_skips_entries_missing_url_or_title() {
        let body = r#"{
            "results": [
                { "title": "", "url": "https://x.com/", "content": "x" },
                { "title": "Has title", "url": "", "content": "y" },
                { "title": "OK", "url": "https://ok.com/", "content": "z" }
            ]
        }"#;
        let r = parse_response(body).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].url, "https://ok.com/");
    }

    #[test]
    fn parse_response_handles_empty_results() {
        let r = parse_response(r#"{"results": []}"#).unwrap();
        assert!(r.is_empty());
    }

    #[test]
    fn parse_response_propagates_invalid_json() {
        assert!(matches!(
            parse_response("not json"),
            Err(SearchError::Parse)
        ));
    }
}
