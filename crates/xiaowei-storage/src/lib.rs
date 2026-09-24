//! Shared application persistence, owned by one Gateway endpoint.

pub mod clipboard_dao;
mod clipboard_migrations;
mod db;
pub mod gateway;
#[allow(dead_code)]
mod gateway_binding;
mod meta;
mod migration;
pub mod settings;
mod sql;
mod usage;
mod validation;

#[cfg(test)]
mod tests {
    mod clipboard_search;
    mod db;
    mod meta;
    mod migration;
    mod settings;
}

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
