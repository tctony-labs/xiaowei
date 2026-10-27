use super::*;
use crate::fetch::{permitted_redirect, truncate, validate_url};

use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use xw_agent_runtime::{
    CancellationToken,
    tools::{AgentTool, ToolContext, ToolError, ToolFuture},
};

const CA: &[u8] = include_bytes!("../../../desktop/tests/fixtures/web/ca.pem");
const CERT: &[u8] = include_bytes!("../../../desktop/tests/fixtures/web/server.pem");
const KEY: &[u8] = include_bytes!("../../../desktop/tests/fixtures/web/server-key.pem");

struct Fixture {
    address: SocketAddr,
    requests: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Fixture {
    async fn new(response: impl Fn(&str) -> Vec<u8> + Send + Sync + 'static) -> Self {
        use tokio_rustls::{TlsAcceptor, rustls};
        let _ = rustls::crypto::ring::default_provider().install_default();
        let certificates = rustls_pemfile::certs(&mut std::io::Cursor::new(CERT))
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let key = rustls_pemfile::private_key(&mut std::io::Cursor::new(KEY))
            .unwrap()
            .unwrap();
        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(certificates, key)
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(vec![]));
        let captured = requests.clone();
        let response = Arc::new(response);
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                let captured = captured.clone();
                let response = response.clone();
                tokio::spawn(async move {
                    let Ok(mut socket) = acceptor.accept(socket).await else {
                        return;
                    };
                    let mut bytes = vec![];
                    let mut buffer = [0; 8192];
                    loop {
                        let Ok(count) = socket.read(&mut buffer).await else {
                            return;
                        };
                        if count == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buffer[..count]);
                        let text = String::from_utf8_lossy(&bytes);
                        if let Some(header_end) = text.find("\r\n\r\n") {
                            let length = text[..header_end]
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .and_then(|value| value.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if bytes.len() >= header_end + 4 + length {
                                break;
                            }
                        }
                    }
                    let request = String::from_utf8_lossy(&bytes).into_owned();
                    captured.lock().unwrap().push(request.clone());
                    let body = response(&request);
                    if body.is_empty() {
                        // A peer that accepts the request but never responds.
                        let _ = socket.read(&mut buffer).await;
                    } else {
                        let _ = socket.write_all(&body).await;
                        let _ = socket.shutdown().await;
                    }
                });
            }
        });
        Self {
            address,
            requests,
            task,
        }
    }

    fn client(&self, redirects: usize) -> reqwest::Client {
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .add_root_certificate(reqwest::Certificate::from_pem(CA).unwrap())
            .timeout(Duration::from_millis(500))
            .user_agent("XiaoWei/WebFetch")
            .redirect(if redirects == 0 {
                reqwest::redirect::Policy::none()
            } else {
                reqwest::redirect::Policy::limited(redirects)
            });
        for host in [
            "www.bing.com",
            "api.tavily.com",
            "api.search.brave.com",
            "google.serper.dev",
            "example.com",
            "www.example.com",
            "other.com",
        ] {
            builder = builder.resolve(host, self.address);
        }
        builder.build().unwrap()
    }

    fn url(&self, path: &str) -> String {
        format!("https://127.0.0.1:{}{path}", self.address.port())
    }
}

fn response(status: u16, content_type: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\n\
        Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

#[derive(Default)]
struct Context {
    cancel: CancellationToken,
    extracted: Mutex<Vec<(String, String)>>,
}

impl ToolContext for Context {
    fn cancellation(&self) -> CancellationToken {
        self.cancel.clone()
    }

    fn extract_text(&self, content: String, prompt: String) -> ToolFuture<'_, String> {
        self.extracted.lock().unwrap().push((content, prompt));
        Box::pin(async { Ok("extracted result".into()) })
    }
}

async fn fetch(
    fixture: &Fixture,
    path: &str,
    context: &Context,
) -> Result<xw_agent_runtime::tools::ToolOutput, ToolError> {
    WebFetch {
        client: fixture.client(0),
    }
    .execute(
        &serde_json::json!({"url": fixture.url(path), "prompt": "extract fixture"}).to_string(),
        context,
    )
    .await
}

#[tokio::test]
async fn fetch_streams_text_html_binary_error_bodies_and_upgrades_http() {
    let fixture = Fixture::new(|request| {
        let path = request.split_whitespace().nth(1).unwrap();
        match path {
            "/html" => response(200, "text/html", "<h1>Title</h1><p>Hello <b>world</b></p>"),
            "/json" => response(200, "application/json", r#"{"fixture":true}"#),
            "/text" => response(200, "text/plain", "plain text"),
            "/error" => response(404, "text/html", "<p>Readable error</p>"),
            "/missing" => b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc".to_vec(),
            _ => response(200, "application/pdf", "binary"),
        }
    })
    .await;
    let context = Context::default();
    for path in ["/html", "/json", "/text", "/error", "/binary", "/missing"] {
        let result = fetch(&fixture, path, &context).await.unwrap();
        let metadata: serde_json::Value =
            serde_json::from_str(result.metadata_json.as_ref().unwrap()).unwrap();
        assert_eq!(
            metadata["webfetch"]["binary"],
            path == "/binary" || path == "/missing"
        );
    }
    let extracted = context.extracted.lock().unwrap().clone();
    assert_eq!(extracted.len(), 4);
    assert!(extracted[0].0.contains("# Title"));
    assert!(extracted[1].0.contains("fixture"));
    assert!(extracted[3].0.contains("Readable error"));
    drop(extracted);
    let url = fixture.url("/text").replacen("https:", "http:", 1);
    WebFetch {
        client: fixture.client(0),
    }
    .execute(
        &serde_json::json!({"url": url, "prompt": "read"}).to_string(),
        &context,
    )
    .await
    .unwrap();
    let requests = fixture.requests.lock().unwrap().clone();
    assert!(
        requests
            .iter()
            .all(|value| value.contains("accept: text/markdown, text/html, */*"))
    );
    assert!(
        requests
            .iter()
            .all(|value| value.contains("user-agent: XiaoWei/WebFetch"))
    );
}

#[tokio::test]
async fn fetch_redirect_limit_chunked_size_cancellation_and_timeout() {
    let fixture = Fixture::new(|request| {
        let path = request.split_whitespace().nth(1).unwrap();
        if path == "/large" {
            let body = "a".repeat(10 * 1024 * 1024 + 1);
            return format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\
                Transfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
                body.len()
            )
            .into_bytes();
        }
        if path == "/hang" {
            return vec![];
        }
        let target = if path == "/cross" {
            "https://other.com/target"
        } else {
            "/loop"
        };
        format!("HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 0\r\n\r\n")
            .into_bytes()
    })
    .await;
    let context = Context::default();
    assert!(
        fetch(&fixture, "/large", &context)
            .await
            .unwrap_err()
            .to_string()
            .contains("10 MiB")
    );
    // Use the production no-follow policy for manual redirect checks.
    let result = fetch(&fixture, "/cross", &context).await.unwrap();
    assert!(result.text.contains("https://other.com/target"));
    assert!(
        fetch(&fixture, "/loop", &context)
            .await
            .unwrap_err()
            .to_string()
            .contains("10")
    );
    assert!(context.extracted.lock().unwrap().is_empty());
    let context = Context::default();
    let cancel = context.cancel.clone();
    let future = fetch(&fixture, "/hang", &context);
    let cancelled = async {
        tokio::task::yield_now().await;
        cancel.cancel();
    };
    let (result, _) = tokio::join!(future, cancelled);
    assert_eq!(result.unwrap_err(), ToolError::Cancelled);
    let timeout = fetch(&fixture, "/hang", &Context::default())
        .await
        .unwrap_err();
    assert!(timeout.to_string().contains("超时"));
}

#[tokio::test]
async fn all_provider_requests_map_their_own_key_results_errors_and_cancellation() {
    let fixture = Fixture::new(|request| {
        if request.contains("api.tavily.com") {
            response(
                200,
                "application/json",
                r#"{"results":[
                {"title":"Tavily","url":"https://a.com","content":"one"}]}"#,
            )
        } else if request.contains("api.search.brave.com") {
            response(
                200,
                "application/json",
                r#"{"web":{"results":[
                {"title":"<b>Brave</b>","url":"https://b.com","description":"A &amp; B"}]}}"#,
            )
        } else if request.contains("google.serper.dev") {
            response(
                200,
                "application/json",
                r#"{"organic":[
                {"title":"Serper","link":"https://c.com","snippet":"three"}]}"#,
            )
        } else {
            response(
                200,
                "text/html",
                r#"<li class="b_algo"><h2><a href="https://a.com">Bing</a></h2>
                <div class="b_caption"><p>four</p></div></li>"#,
            )
        }
    })
    .await;
    let providers: Vec<Box<dyn SearchTool>> = vec![
        Box::new(BingSearch::with_client(fixture.client(5))),
        Box::new(TavilySearch::with_client(
            fixture.client(10),
            "tavily-fixture-key".into(),
        )),
        Box::new(BraveSearch::with_client(
            fixture.client(10),
            "brave-fixture-key".into(),
        )),
        Box::new(SerperSearch::with_client(
            fixture.client(10),
            "serper-fixture-key".into(),
        )),
    ];
    for (index, provider) in providers.iter().enumerate() {
        let results = provider
            .search(
                SearchRequest {
                    query: "focused query 中文".into(),
                    max_results: 3,
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(results.len(), 1);
        if index == 2 {
            assert_eq!(results[0].snippet, "A & B");
        }
    }
    let requests = fixture.requests.lock().unwrap().clone();
    assert!(requests[0].starts_with("GET /search?q=focused+query+%E4%B8%AD%E6%96%87"));
    assert!(requests[0].contains("accept-language: en-US,en;q=0.9"));
    let tavily: serde_json::Value =
        serde_json::from_str(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(tavily["api_key"], "tavily-fixture-key");
    assert_eq!(tavily["max_results"], 3);
    assert_eq!(tavily["include_answer"], false);
    assert!(requests[2].contains("x-subscription-token: brave-fixture-key"));
    assert!(requests[3].contains("x-api-key: serper-fixture-key"));
    assert!(!requests[3].contains("tavily-fixture-key"));
    drop(requests);

    for status in [401, 403, 422, 429, 500] {
        let fixture =
            Fixture::new(move |_| response(status, "text/plain", "never expose secret-key")).await;
        let provider = BraveSearch::with_client(fixture.client(10), "key".into());
        let result = provider
            .search(
                SearchRequest {
                    query: "query".into(),
                    max_results: 1,
                },
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(
            result,
            match status {
                401 | 403 | 422 => SearchError::InvalidApiKey(status),
                429 => SearchError::QuotaExceeded(status),
                _ => SearchError::Upstream(status),
            }
        );
        assert!(!result.to_string().contains("secret-key"));
    }
    let fixture = Fixture::new(|_| vec![]).await;
    let provider = BingSearch::with_client(fixture.client(5));
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        provider
            .search(
                SearchRequest {
                    query: "query".into(),
                    max_results: 1
                },
                cancel
            )
            .await
            .unwrap_err(),
        SearchError::Cancelled
    );
}

#[test]
fn url_and_redirect_boundaries_match_the_original_tool() {
    for raw in ["https://example.com", "http://1.2.3.4/path"] {
        assert!(validate_url(raw).is_ok());
    }
    for raw in [
        "ftp://example.com",
        "https://localhost",
        "https://user:secret@example.com",
    ] {
        assert!(validate_url(raw).is_err());
    }
    assert!(validate_url(&format!("https://example.com/{}", "中".repeat(700))).is_err());
    let origin = validate_url("https://example.com/a").unwrap();
    assert!(permitted_redirect(
        &origin,
        &validate_url("https://www.example.com/b").unwrap()
    ));
    for raw in [
        "https://other.com",
        "http://example.com",
        "https://example.com:8443",
    ] {
        assert!(!permitted_redirect(&origin, &validate_url(raw).unwrap()));
    }
    let (content, truncated) = truncate(&"中".repeat(100_001));
    assert!(truncated);
    assert!(content.contains("300003 bytes"));
    assert_eq!(
        content.chars().filter(|value| *value == '中').count(),
        100_000
    );
}

#[test]
fn provider_instances_are_independent_trait_objects() {
    let providers: Vec<Box<dyn SearchTool>> = vec![
        Box::new(BingSearch::new().unwrap()),
        Box::new(TavilySearch::new("tavily-fixture".into()).unwrap()),
        Box::new(BraveSearch::new("brave-fixture".into()).unwrap()),
        Box::new(SerperSearch::new("serper-fixture".into()).unwrap()),
    ];
    assert_eq!(
        providers
            .iter()
            .map(|provider| provider.provider())
            .collect::<Vec<_>>(),
        ["bing", "tavily", "brave", "serper"]
    );
}
