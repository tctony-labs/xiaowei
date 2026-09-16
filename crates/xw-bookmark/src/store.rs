//! 书签存储：加载文件 → 扁平化原始列表 → `notify` 监听文件变更自动重建。
//!
//! 只提供**原始数据**（[`BookmarkEntry`] 列表），不做任何搜索 / 匹配。

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};

use crate::parse::{parse_bookmarks, BookmarkEntry};
use crate::path::default_chrome_bookmarks_path;

/// 文件事件 debounce 窗口：Chrome 原子写（临时文件 + rename + `.bak`）一次保存会炸出多个
/// 命中事件，攒批后只重新加载 / 重建一次。
const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

/// 共享的原始书签列表句柄。使用方（如 host 的 provider）持有同一句柄读取快照。
pub type BookmarkEntries = Arc<RwLock<Vec<BookmarkEntry>>>;

/// 书签存储：持有原始列表 + 文件监听器。列表在文件变更时后台自动重建。
pub struct BookmarkStore {
    path: PathBuf,
    entries: BookmarkEntries,
    // 持有 debouncer（内含 watcher）保活；drop 时自动停止监听。
    _watcher: Option<Debouncer<RecommendedWatcher>>,
}

impl BookmarkStore {
    /// 用默认 Chrome 书签路径打开。找不到路径时返回 `None`。
    pub fn open_default() -> Option<Self> {
        let path = default_chrome_bookmarks_path()?;
        Some(Self::open(path))
    }

    /// 打开指定路径：立即加载一次（失败则空列表），并启动文件监听。
    pub fn open(path: impl Into<PathBuf>) -> Self {
        Self::open_shared(path, Arc::new(RwLock::new(Vec::new())))
    }

    /// 用外部提供的共享列表句柄打开：立即加载一次并启动监听，之后文件变更写回同一句柄。
    ///
    /// 适合「使用方先持有空列表、store 稍后在后台构建并复用同一句柄」的场景：使用方直接
    /// 读该列表做自己的匹配，无需感知 store / watcher 的存在。
    pub fn open_shared(path: impl Into<PathBuf>, entries: BookmarkEntries) -> Self {
        Self::open_shared_with(path, entries, || {})
    }

    /// 同 [`open_shared`](Self::open_shared)，并在**每次成功加载后**（初次 + 文件变更）调用
    /// `on_change`。使用方可在钩子里从共享列表重建自己的派生索引（如拼音 haystack），
    /// 使派生数据随文件变更自动保持最新。
    pub fn open_shared_with<F>(path: impl Into<PathBuf>, entries: BookmarkEntries, on_change: F) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        let path = path.into();
        load_into(&path, &entries);
        on_change();

        let watcher = start_watcher(&path, Arc::clone(&entries), on_change);
        Self {
            path,
            entries,
            _watcher: watcher,
        }
    }

    /// 共享的原始书签列表句柄（供使用方读取快照）。
    pub fn entries(&self) -> BookmarkEntries {
        Arc::clone(&self.entries)
    }

    /// 当前条目数。
    pub fn len(&self) -> usize {
        self.entries.read().map(|e| e.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 立即重新加载（测试 / 手动刷新用）。
    pub fn reload(&self) {
        load_into(&self.path, &self.entries);
    }
}

/// 读取并解析文件，写入列表；任何失败都记日志并保留旧数据。
fn load_into(path: &Path, entries: &BookmarkEntries) {
    let json = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(err) => {
            log::warn!("读取书签文件失败 path={} err={err}", path.display());
            return;
        }
    };
    match parse_bookmarks(&json) {
        Ok(parsed) => {
            let count = parsed.len();
            if let Ok(mut guard) = entries.write() {
                *guard = parsed;
            }
            log::info!("书签列表重建完成 count={count} path={}", path.display());
        }
        Err(err) => log::warn!("解析书签文件失败 path={} err={err}", path.display()),
    }
}

/// 监听书签文件所在目录（Chrome 常以 rename 原子写入，监听父目录更稳）。debounce 窗口内的
/// 事件攒成一批，只在涉及目标文件时重新加载 / 重建一次。
fn start_watcher<F>(path: &Path, entries: BookmarkEntries, on_change: F) -> Option<Debouncer<RecommendedWatcher>>
where
    F: Fn() + Send + Sync + 'static,
{
    let watch_dir = path.parent()?.to_path_buf();
    let target = path.to_path_buf();

    let mut debouncer = match new_debouncer(WATCH_DEBOUNCE, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        // 仅当这批事件涉及目标文件时才重建。
        if events.iter().any(|e| e.path == target) {
            load_into(&target, &entries);
            on_change();
        }
    }) {
        Ok(d) => d,
        Err(err) => {
            log::warn!("创建书签文件 watcher 失败 err={err}");
            return None;
        }
    };

    if let Err(err) = debouncer.watcher().watch(&watch_dir, RecursiveMode::NonRecursive) {
        log::warn!("监听书签目录失败 dir={} err={err}", watch_dir.display());
        return None;
    }
    Some(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const BOOKMARKS_V1: &str = r#"{ "roots": { "bookmark_bar": {
        "type": "folder", "name": "书签栏", "children": [
            { "type": "url", "name": "GitHub", "url": "https://github.com" }
        ]
    } } }"#;

    const BOOKMARKS_V2: &str = r#"{ "roots": { "bookmark_bar": {
        "type": "folder", "name": "书签栏", "children": [
            { "type": "url", "name": "GitHub", "url": "https://github.com" },
            { "type": "url", "name": "GitLab", "url": "https://gitlab.com" }
        ]
    } } }"#;

    #[test]
    fn open_loads_raw_entries() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Bookmarks");
        std::fs::write(&file, BOOKMARKS_V1).unwrap();

        let store = BookmarkStore::open(&file);
        assert_eq!(store.len(), 1);
        assert_eq!(store.entries().read().unwrap()[0].name, "GitHub");
    }

    #[test]
    fn reload_picks_up_changes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Bookmarks");
        std::fs::write(&file, BOOKMARKS_V1).unwrap();

        let store = BookmarkStore::open(&file);
        assert_eq!(store.len(), 1);

        let mut f = std::fs::File::create(&file).unwrap();
        f.write_all(BOOKMARKS_V2.as_bytes()).unwrap();
        f.sync_all().unwrap();

        store.reload();
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn missing_file_yields_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Bookmarks");
        let store = BookmarkStore::open(&file);
        assert!(store.is_empty());
    }

    #[test]
    fn shared_handle_is_written_by_store() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Bookmarks");
        std::fs::write(&file, BOOKMARKS_V1).unwrap();

        let entries: BookmarkEntries = Arc::new(RwLock::new(Vec::new()));
        let _store = BookmarkStore::open_shared(&file, Arc::clone(&entries));
        assert_eq!(entries.read().unwrap().len(), 1);
    }

    #[test]
    fn on_change_hook_fires_on_initial_load() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Bookmarks");
        std::fs::write(&file, BOOKMARKS_V1).unwrap();

        let calls = Arc::new(AtomicUsize::new(0));
        let entries: BookmarkEntries = Arc::new(RwLock::new(Vec::new()));
        let calls_hook = Arc::clone(&calls);
        let _store = BookmarkStore::open_shared_with(&file, Arc::clone(&entries), move || {
            calls_hook.fetch_add(1, Ordering::SeqCst);
        });
        // 初次加载后钩子至少被调用一次。
        assert!(calls.load(Ordering::SeqCst) >= 1);
        assert_eq!(entries.read().unwrap().len(), 1);
    }
}
