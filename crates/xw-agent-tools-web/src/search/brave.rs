use regex::Regex;
use serde::Deserialize;

use xw_agent_runtime::{CancellationToken, tools::ToolError};

use super::{SearchError, SearchFuture, SearchRequest, SearchResult, SearchTool};

const ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";

pub struct BraveSearch {
    pub(super) client: reqwest::Client,
    api_key: String,
}

impl BraveSearch {
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
struct BraveResponse {
    #[serde(default)]
    web: Option<BraveWebSection>,
}

#[derive(Deserialize)]
struct BraveWebSection {
    #[serde(default)]
    results: Vec<BraveHit>,
}

#[derive(Deserialize)]
struct BraveHit {
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    description: String,
}

/// Brave's `description` field can contain `<strong>` highlights — strip them.
fn strip_html_tags(s: &str) -> String {
    let tag = Regex::new(r"<[^>]+>").unwrap();
    tag.replace_all(s, "")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .trim()
        .to_string()
}

fn parse_response(body: &str) -> Result<Vec<SearchResult>, SearchError> {
    let resp: BraveResponse = serde_json::from_str(body).map_err(|_| SearchError::Parse)?;
    let Some(web) = resp.web else {
        return Ok(Vec::new());
    };
    Ok(web
        .results
        .into_iter()
        .filter(|h| !h.url.is_empty() && !h.title.is_empty())
        .map(|h| SearchResult {
            title: strip_html_tags(&h.title),
            url: h.url,
            snippet: strip_html_tags(&h.description),
        })
        .collect())
}

impl SearchTool for BraveSearch {
    fn provider(&self) -> &'static str {
        "brave"
    }

    fn search(&self, request: SearchRequest, cancel: CancellationToken) -> SearchFuture<'_> {
        Box::pin(async move {
            let request = self
                .client
                .get(ENDPOINT)
                .query(&[
                    ("q", request.query),
                    ("count", request.max_results.clamp(1, 20).to_string()),
                ])
                .header("Accept", "application/json")
                .header("X-Subscription-Token", &self.api_key);
            let text = super::response_text(request, cancel, &[401, 403, 422]).await?;
            parse_response(&text)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_response_extracts_web_results() {
        let body = r#"{
            "web": {
                "results": [
                    {
                        "title": "Tauri",
                        "url": "https://tauri.app/",
                        "description": "<strong>Tauri</strong> is a framework"
                    },
                    {
                        "title": "GitHub - tauri",
                        "url": "https://github.com/tauri-apps/tauri",
                        "description": "Build smaller &amp; faster"
                    }
                ]
            }
        }"#;
        let r = parse_response(body).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].title, "Tauri");
        assert_eq!(r[0].snippet, "Tauri is a framework");
        assert_eq!(r[1].snippet, "Build smaller & faster");
    }

    #[test]
    fn parse_response_handles_missing_web_section() {
        let r = parse_response(r#"{"infobox": {}}"#).unwrap();
        assert!(r.is_empty());
    }

    #[test]
    fn parse_response_skips_entries_missing_url_or_title() {
        let body = r#"{
            "web": { "results": [
                { "title": "", "url": "https://x.com/", "description": "x" },
                { "title": "OK", "url": "https://ok.com/", "description": "z" }
            ] }
        }"#;
        let r = parse_response(body).unwrap();
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn strip_html_tags_handles_entities() {
        assert_eq!(strip_html_tags("a &amp; b"), "a & b");
        assert_eq!(strip_html_tags("<b>x</b>  y"), "x  y");
    }
}
