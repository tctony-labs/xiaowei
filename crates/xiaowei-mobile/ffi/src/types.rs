use xiaowei_mobile as mobile;

#[derive(Clone, uniffi::Record)]
pub struct SessionContext {
    pub server: String,
    pub authenticated: Option<Vec<u8>>,
    pub connect: bool,
}

impl From<SessionContext> for mobile::SessionContext {
    fn from(value: SessionContext) -> Self {
        Self {
            server: value.server,
            authenticated: value.authenticated,
            connect: value.connect,
        }
    }
}

#[derive(Clone, Copy, uniffi::Enum)]
pub enum Transport {
    Auto,
    Http,
    Websocket,
}

#[derive(Clone, uniffi::Record)]
pub struct RequestOptions {
    pub timeout_ms: Option<u32>,
    pub transport: Transport,
}

impl From<RequestOptions> for mobile::RequestOptions {
    fn from(value: RequestOptions) -> Self {
        Self {
            timeout_ms: value.timeout_ms,
            transport: match value.transport {
                Transport::Auto => mobile::Transport::Auto,
                Transport::Http => mobile::Transport::Http,
                Transport::Websocket => mobile::Transport::Websocket,
            },
        }
    }
}

#[derive(Clone, uniffi::Record)]
pub struct AccountOutcome {
    pub code: i32,
    pub msg: String,
    pub authenticated: Option<Vec<u8>>,
    pub credential_version: u64,
    pub checkpoint: bool,
    pub next_maintenance_at_ms: i64,
}

impl From<mobile::AccountOutcome> for AccountOutcome {
    fn from(value: mobile::AccountOutcome) -> Self {
        Self {
            code: value.code,
            msg: value.msg,
            authenticated: value.authenticated,
            credential_version: value.credential_version,
            checkpoint: value.checkpoint,
            next_maintenance_at_ms: value.next_maintenance_at_ms,
        }
    }
}

#[derive(Clone, Copy, uniffi::Enum)]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

#[derive(Clone, Copy, uniffi::Enum)]
pub enum Authentication {
    Authenticated,
    Rejected,
    Unavailable,
}

#[derive(Clone, uniffi::Record)]
pub struct ConnectionSnapshot {
    pub generation: u64,
    pub status: ConnectionStatus,
    pub authentication: Option<Authentication>,
}

impl From<mobile::ConnectionSnapshot> for ConnectionSnapshot {
    fn from(value: mobile::ConnectionSnapshot) -> Self {
        Self {
            generation: value.generation,
            status: match value.status {
                mobile::Status::Disconnected => ConnectionStatus::Disconnected,
                mobile::Status::Connecting => ConnectionStatus::Connecting,
                mobile::Status::Connected => ConnectionStatus::Connected,
                mobile::Status::Reconnecting => ConnectionStatus::Reconnecting,
            },
            authentication: value.authentication.map(|auth| match auth {
                mobile::Authentication::Authenticated => Authentication::Authenticated,
                mobile::Authentication::Rejected => Authentication::Rejected,
                mobile::Authentication::Unavailable => Authentication::Unavailable,
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum LocalErrorKind {
    Closed,
    Busy,
    InvalidState,
    Runtime,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MobileError {
    #[error("{msg}")]
    Core {
        code: i32,
        category: String,
        msg: String,
    },
    #[error("{msg}")]
    Local { kind: LocalErrorKind, msg: String },
}

impl From<mobile::MobileError> for MobileError {
    fn from(value: mobile::MobileError) -> Self {
        match value {
            mobile::MobileError::Core {
                code,
                category,
                msg,
            } => Self::Core {
                code,
                category,
                msg,
            },
            mobile::MobileError::Local { kind, msg } => Self::Local {
                kind: match kind {
                    mobile::LocalErrorKind::Closed => LocalErrorKind::Closed,
                    mobile::LocalErrorKind::Busy => LocalErrorKind::Busy,
                    mobile::LocalErrorKind::InvalidState => LocalErrorKind::InvalidState,
                    mobile::LocalErrorKind::Runtime => LocalErrorKind::Runtime,
                },
                msg,
            },
        }
    }
}
