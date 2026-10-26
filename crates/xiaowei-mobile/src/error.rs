use thiserror::Error;

pub type Result<T> = std::result::Result<T, MobileError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalErrorKind {
    Closed,
    Busy,
    InvalidState,
    Runtime,
}

#[derive(Clone, Debug, Error)]
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

impl MobileError {
    pub(crate) fn local(kind: LocalErrorKind, msg: &str) -> Self {
        Self::Local {
            kind,
            msg: msg.into(),
        }
    }

    pub(crate) fn closed() -> Self {
        Self::local(LocalErrorKind::Closed, "移动客户端或操作已关闭")
    }
}

impl From<xw_api::Error> for MobileError {
    fn from(value: xw_api::Error) -> Self {
        Self::Core {
            code: value.code,
            category: value.category.into(),
            msg: value.message,
        }
    }
}
