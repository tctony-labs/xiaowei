use tokio_util::sync::CancellationToken;

use crate::{Error, Result};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Transport {
    /// Prefer a compatible, authenticated WebSocket; otherwise choose HTTP before sending.
    #[default]
    Auto,
    Http,
    /// Require a compatible WebSocket. A failed request is never replayed over HTTP.
    Websocket,
}

#[derive(Clone, Debug, Default)]
pub struct RequestOptions {
    /// None uses 15 seconds; zero disables only the network wait timer.
    /// Values above i32::MAX are rejected.
    pub timeout_ms: Option<u32>,
    pub transport: Transport,
}

#[derive(Clone, Default, PartialEq, Eq)]
pub struct Session {
    pub server: String,
    pub session_id: String,
    pub access_token: String,
    pub access_expires_at_ms: i64,
}

#[derive(Clone, Default, PartialEq, Eq)]
pub struct Target {
    pub server: String,
    pub session: Option<Session>,
}

#[derive(Clone)]
pub struct RequestContext {
    pub target: Target,
    pub options: RequestOptions,
    pub cancellation: CancellationToken,
    pub now_ms: i64,
}

impl RequestContext {
    pub fn new(target: Target) -> Self {
        Self {
            target,
            options: RequestOptions::default(),
            cancellation: CancellationToken::new(),
            now_ms: now_ms(),
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn normalize_server(value: &str) -> Result<String> {
    let url =
        url::Url::parse(value.trim()).map_err(|_| Error::invalid("请先选择有效的服务器地址"))?;
    let loopback = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err(Error::invalid("请先选择有效的服务器地址"));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}
