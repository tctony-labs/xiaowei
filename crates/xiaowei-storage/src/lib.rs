//! Shared application persistence, owned by one Gateway endpoint.

pub mod db;
pub mod gateway;
pub mod migration;
mod validation;

pub use db::Database;
pub use xw_contracts::xiaowei::storage as pb;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Sql(#[from] sqlx::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}
