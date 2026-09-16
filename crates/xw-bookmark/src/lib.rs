//! Chrome 书签**原始数据**提供者：解析 + 文件监听自动重建。
//!
//! 纯业务 crate：不依赖 Tauri / xw-domain，也**不含搜索/匹配逻辑**——只负责把 Chrome
//! `Bookmarks` 解析成扁平的 [`BookmarkEntry`] 列表，并在文件变更时自动刷新。
//! 具体的模糊匹配 / 打分留给使用方（host 的 `BookmarkProvider`）。
//!
//! - [`parse_bookmarks`]：解析 Chrome `Bookmarks` JSON，扁平化为 [`BookmarkEntry`]。
//! - [`default_chrome_bookmarks_path`]：定位各平台默认 Chrome 书签文件。
//! - [`BookmarkStore`]：加载 + `notify` 监听文件变更自动重建原始列表。

mod parse;
mod path;
mod store;

pub use parse::{parse_bookmarks, BookmarkEntry};
pub use path::default_chrome_bookmarks_path;
pub use store::{BookmarkEntries, BookmarkStore};
