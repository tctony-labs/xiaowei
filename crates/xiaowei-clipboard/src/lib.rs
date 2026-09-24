mod dao;
pub mod gateway;
#[allow(dead_code)]
mod gateway_binding;
mod resources;
mod service;
mod store;
mod toolkit;
mod types;
mod usage;

pub use service::{ClipboardBackend, Service};
pub use store::Store;
pub use toolkit::SystemClipboard;
pub use types::{ClipboardCategory, ClipboardData, ClipboardItem, ListOptions};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
