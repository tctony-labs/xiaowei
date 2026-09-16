//! macOS 应用与系统设置面板的**原始数据源**：扫描 bundle + 提取图标 + 文件监听。
//!
//! 纯业务 crate：不依赖 Tauri / xw-domain，也**不含搜索/匹配逻辑**。
//! 默认扫描以下目录的 `.app`：
//!
//! - `/Applications`
//! - `/System/Applications`
//! - `/System/Library/CoreServices/Applications`
//! - `~/Applications`
//!
//! 扫描结果扁平化为 [`AppEntry`] 列表，并在目录变更时自动刷新。模糊匹配 / 打分留给使用方
//! （host 的 `AppProvider`）。
//!
//! - [`scan_apps`]：扫描应用目录，扁平化为 [`AppEntry`]。
//! - [`AppStore`]：加载 + `notify` 监听目录变更自动重扫。
//! - [`application_dirs`]：各平台默认应用扫描目录。
//!
//! 只扫应用（`.app`）。系统设置面板**不在**本 crate：现代 macOS 的 `.prefPane` 已是空壳，
//! 改由 host 侧内置清单（bundle id → `x-apple.systempreferences:` URL）提供。
//! 图标获取也不在本 crate：交给 `xiaowei_platform::app_icon`（走系统 API，兼容 asset catalog）。

mod entry;
mod path;
mod scan;
mod store;

pub use entry::{AppEntries, AppEntry, AppKind};
pub use path::application_dirs;
pub use scan::scan_apps;
pub use store::AppStore;
