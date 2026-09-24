mod dao;
pub mod gateway;
#[allow(dead_code)]
mod gateway_binding;
mod paste;
mod resources;
mod runtime;
mod service;
mod store;
mod toolkit;
mod types;
mod usage;

pub use paste::{request_accessibility_permission, send_paste_shortcut};
pub use service::{ClipboardBackend, Service};
pub use store::Store;
pub use toolkit::SystemClipboard;
pub use types::{ClipboardCategory, ClipboardData, ClipboardItem, ListOptions};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
