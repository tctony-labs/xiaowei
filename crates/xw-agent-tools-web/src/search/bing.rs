use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use regex::Regex;
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};
use xw_agent_runtime::{CancellationToken, tools::ToolError};

use super::{SearchFuture, SearchRequest, SearchResult, SearchTool};

const BROWSER_UA: &str = concat!(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ",
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
);

pub struct BingSearch {
    pub(super) client: reqwest::Client,
}

impl BingSearch {
    #[cfg(test)]
    pub(crate) fn with_client(client: reqwest::Client) -> Self {
        Self { client }
    }

    pub fn new() -> Result<Self, ToolError> {
        Ok(Self {
            client: super::client(5)?,
        })
    }
}

impl SearchTool for BingSearch {
    fn provider(&self) -> &'static str {
        "bing"
    }

    fn search(&self, request: SearchRequest, cancel: CancellationToken) -> SearchFuture<'_> {
        Box::pin(async move {
            let response = self
                .client
                .get("https://www.bing.com/search")
                .query(&[("q", request.query)])
                .header(USER_AGENT, BROWSER_UA)
                .header(ACCEPT, "text/html,application/xhtml+xml")
                .header(ACCEPT_LANGUAGE, "en-US,en;q=0.9");
            let text = super::response_text(response, cancel, &[401, 403]).await?;
            let mut results = parse_bing_html(&text);
            results.truncate(request.max_results);
            Ok(results)
        })
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Decode HTML entity for `&amp;` only (the only one that affects URLs in Bing's href).
fn unescape_amp(s: &str) -> String {
    s.replace("&amp;", "&")
}

/// 提取 Bing `ck/a` 重定向链接里的真实 URL。
/// 形如 `https://www.bing.com/ck/a?...&u=a1<base64url>&ntb=1`。
/// 找不到 `u=a1` 时退化为 unescape 后的原值。
fn unwrap_bing_url(href: &str) -> String {
    let raw = unescape_amp(href.trim());
    if let Some(idx) = raw.find("u=a1") {
        let tail = &raw[idx + 4..];
        let end = tail.find('&').unwrap_or(tail.len());
        let token = &tail[..end];
        if let Ok(bytes) = URL_SAFE_NO_PAD.decode(token.trim_end_matches('='))
            && let Ok(url) = String::from_utf8(bytes)
        {
            return url;
        }
    }
    if let Some(idx) = raw.find("&url=") {
        let tail = &raw[idx + 5..];
        let end = tail.find('&').unwrap_or(tail.len());
        return percent_decode(&tail[..end]);
    }
    raw
}

/// 朴素 HTML 文本清洗。
pub(super) fn strip_html(s: &str) -> String {
    let tag = Regex::new(r"<[^>]+>").unwrap();
    let no_tag = tag.replace_all(s, "");
    let decoded = no_tag
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#0183;", "·")
        .replace("&#32;", " ")
        .replace("&ensp;", " ")
        .replace("&nbsp;", " ");
    let ws = Regex::new(r"\s+").unwrap();
    ws.replace_all(decoded.trim(), " ").to_string()
}

fn parse_bing_html(body: &str) -> Vec<SearchResult> {
    let li_re = Regex::new(r#"(?s)<li[^>]*\bclass="[^"]*\bb_algo\b[^"]*"[^>]*>"#).unwrap();
    let h2_re =
        Regex::new(r#"(?s)<h2[^>]*>\s*<a[^>]*\bhref="([^"]+)"[^>]*>(.*?)</a>\s*</h2>"#).unwrap();
    let snippet_re =
        Regex::new(r#"(?s)<div[^>]*\bclass="[^"]*\bb_caption\b[^"]*"[^>]*>.*?<p[^>]*>(.*?)</p>"#)
            .unwrap();

    let starts: Vec<usize> = li_re.find_iter(body).map(|m| m.start()).collect();
    let mut out = Vec::new();
    for (i, &start) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(body.len());
        let block = &body[start..end];

        let Some(h2) = h2_re.captures(block) else {
            continue;
        };
        let href = h2.get(1).unwrap().as_str();
        let title = strip_html(h2.get(2).unwrap().as_str());
        if title.is_empty() {
            continue;
        }
        let url = unwrap_bing_url(href);
        if !url.starts_with("http") {
            continue;
        }
        let snippet = snippet_re
            .captures(block)
            .map(|c| strip_html(c.get(1).unwrap().as_str()))
            .unwrap_or_default();
        out.push(SearchResult {
            title,
            url,
            snippet,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwrap_bing_base64() {
        let token = URL_SAFE_NO_PAD.encode(b"https://tauri.app/");
        let href = format!("https://www.bing.com/ck/a?!&amp;&amp;p=xxx&amp;u=a1{token}&amp;ntb=1");
        assert_eq!(unwrap_bing_url(&href), "https://tauri.app/");
    }

    #[test]
    fn unwrap_passthrough_non_bing() {
        assert_eq!(
            unwrap_bing_url("https://rust-lang.org/"),
            "https://rust-lang.org/"
        );
    }

    #[test]
    fn parse_minimal_bing_html() {
        let url1 = URL_SAFE_NO_PAD.encode(b"https://tauri.app/");
        let url2 = URL_SAFE_NO_PAD.encode(b"https://github.com/tauri-apps/tauri");
        let html = format!(
            r##"
        <ol id="b_results">
        <li class="b_algo">
          <h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=a1{u1}&amp;ntb=1"
          ><strong>Tauri</strong> 2.0 | <strong>Tauri</strong></a></h2>
          <div class="b_caption"><p class="b_lineclamp2">
            The cross-platform app building toolkit.</p></div>
        </li>
        <li class="b_algo">
          <h2><a href="https://www.bing.com/ck/a?!&amp;p=y&amp;u=a1{u2}&amp;ntb=1"
          ><strong>GitHub</strong> - tauri-apps/tauri</a></h2>
          <div class="b_caption"><p class="b_lineclamp2">
            Build smaller, faster, and more secure desktop applications.</p></div>
        </li>
        </ol>
        "##,
            u1 = url1,
            u2 = url2,
        );
        let r = parse_bing_html(&html);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].title, "Tauri 2.0 | Tauri");
        assert_eq!(r[0].url, "https://tauri.app/");
        assert!(r[0].snippet.contains("cross-platform"));
        assert_eq!(r[1].url, "https://github.com/tauri-apps/tauri");
    }

    #[test]
    fn strip_html_entities() {
        assert_eq!(strip_html("a &amp; b"), "a & b");
        assert_eq!(strip_html("<b>x</b>  y"), "x y");
        assert_eq!(strip_html("1 day ago&ensp;·&ensp;Rust"), "1 day ago · Rust");
        assert_eq!(
            strip_html("Apr 29, 2026&nbsp;&#0183;&#32;Tauri"),
            "Apr 29, 2026 · Tauri"
        );
    }
}
