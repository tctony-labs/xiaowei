//! 扫描出的可启动条目数据模型。

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use serde::Serialize;

/// 条目类别：普通应用 or 系统设置偏好面板。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppKind {
    /// `/Applications` 等目录下的 `.app`。
    Application,
    /// `PreferencePanes` 目录下的 `.prefPane`（系统设置面板）。
    PreferencePane,
}

/// 扁平化后的单个可启动条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    /// 展示名（`CFBundleDisplayName` / `CFBundleName`，缺失时回退文件名）。
    pub name: String,
    /// bundle 绝对路径（用 `open` 启动 / 打开面板）。
    pub path: PathBuf,
    /// bundle id（`CFBundleIdentifier`）；`.prefPane` 可能为空，此时用 `path` 作稳定键。
    pub bundle_id: String,
    /// 搜索别名（扫描时由硬编码映射表填充）。
    pub aliases: Vec<String>,
    /// 条目类别。
    pub kind: AppKind,
}

impl AppEntry {
    /// 稳定唯一键：优先 bundle id，缺失时回退到路径。用于生成 stable 搜索结果 id。
    pub fn stable_key(&self) -> String {
        if self.bundle_id.is_empty() {
            self.path.to_string_lossy().into_owned()
        } else {
            self.bundle_id.clone()
        }
    }
}

/// 共享的应用列表句柄：`AppStore` 后台扫描后写入、目录变更时刷新，使用方直接读取快照。
pub type AppEntries = Arc<RwLock<Vec<AppEntry>>>;
