pub mod gateway;
mod service;
mod store;
mod toolkit;
mod types;

pub use service::{ClipboardBackend, Service};
pub use store::Store;
pub use toolkit::SystemClipboard;
pub use types::{ClipboardCategory, ClipboardData, ClipboardItem, ListOptions};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
