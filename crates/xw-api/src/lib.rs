//! XiaoWei network execution and account sessions, independent of application adapters.
pub mod account;
pub mod connection;
pub mod context;
pub mod contract;
mod http;
mod methods;
pub mod websocket;
pub mod wire;

pub use context::{
    RequestContext, RequestOptions, Session, Target, Transport, normalize_server, now_ms,
};
use proto_server_rs::xiaowei::server::ErrorCode;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug)]
pub struct Error {
    pub code: i32,
    pub message: String,
    pub category: &'static str,
}

impl Error {
    pub fn invalid(message: &str) -> Self {
        Self {
            code: ErrorCode::InvalidArgument as i32,
            message: message.into(),
            category: "argument",
        }
    }

    pub fn unavailable(message: &str) -> Self {
        Self {
            code: ErrorCode::Unavailable as i32,
            message: message.into(),
            category: "network",
        }
    }

    pub fn unauthenticated() -> Self {
        Self {
            code: ErrorCode::Unauthenticated as i32,
            message: "没有可用的登录凭据，请刷新会话或重新登录".into(),
            category: "credentials",
        }
    }

    pub fn cancelled() -> Self {
        Self {
            category: "cancelled",
            ..Self::unavailable("服务器请求已取消")
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

pub struct Client {
    http: reqwest::Client,
    closed: tokio_util::sync::CancellationToken,
    pub connection: std::sync::Arc<connection::Connection>,
}

impl Client {
    pub fn new() -> Result<std::sync::Arc<Self>> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error::unavailable("无法创建网络客户端"))?;
        Ok(std::sync::Arc::new(Self {
            http,
            closed: tokio_util::sync::CancellationToken::new(),
            connection: connection::Connection::new(),
        }))
    }

    pub async fn close(&self) {
        self.closed.cancel();
        self.connection.close().await;
    }
}
