//! 书签存储：加载文件 → 扁平化原始列表 → `notify` 监听文件变更自动重建。
//!
//! 只提供**原始数据**（[`BookmarkEntry`] 列表），不做任何搜索 / 匹配。

use std::collections::HashSet;
use std::io::ErrorKind;
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
    /// `Bookmarks` 同时合并、监听同目录的 `AccountBookmarks`。
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
        if load_into(&path, &entries) {
            on_change();
        }

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

/// Chrome 将本地与账号书签分别保存；即使文件尚不存在，也必须监听后续创建。
fn bookmark_paths(path: &Path) -> Vec<PathBuf> {
    let mut paths = vec![path.to_path_buf()];
    if path.file_name().is_some_and(|name| name == "Bookmarks") {
        paths.push(path.with_file_name("AccountBookmarks"));
    }
    paths
}

/// 合并存在的书签文件；缺失视为空，其他读取或解析失败保留上次完整快照。
fn load_into(path: &Path, entries: &BookmarkEntries) -> bool {
    let mut merged = Vec::new();
    let mut seen = HashSet::new();
    let mut loaded_paths = Vec::new();

    for source in bookmark_paths(path) {
        let json = match std::fs::read_to_string(&source) {
            Ok(json) => json,
            Err(err) if err.kind() == ErrorKind::NotFound => continue,
            Err(err) => {
                log::warn!("读取书签文件失败 path={} err={err}", source.display());
                return false;
            }
        };
        let parsed = match parse_bookmarks(&json) {
            Ok(parsed) => parsed,
            Err(err) => {
                log::warn!("解析书签文件失败 path={} err={err}", source.display());
                return false;
            }
        };
        loaded_paths.push(source);
        for entry in parsed {
            let key = (entry.name.clone(), entry.url.clone(), entry.folder_path.clone());
            if seen.insert(key) {
                merged.push(entry);
            }
        }
    }

    let count = merged.len();
    let Ok(mut guard) = entries.write() else { return false };
    *guard = merged;
    log::info!("书签列表重建完成 count={count} paths={loaded_paths:?}");
    true
}

/// 监听书签文件所在目录（Chrome 常以 rename 原子写入，监听父目录更稳）。debounce 窗口内的
/// 事件攒成一批，只在涉及目标文件时重新加载 / 重建一次。
fn start_watcher<F>(path: &Path, entries: BookmarkEntries, on_change: F) -> Option<Debouncer<RecommendedWatcher>>
where
    F: Fn() + Send + Sync + 'static,
{
    let watch_dir = path.parent()?;
    // macOS 文件事件使用真实路径（例如 /var 的目标 /private/var）。
    let watch_dir = watch_dir.canonicalize().unwrap_or_else(|_| watch_dir.to_path_buf());
    let primary = watch_dir.join(path.file_name()?);
    let targets = bookmark_paths(&primary);

    let mut debouncer = match new_debouncer(WATCH_DEBOUNCE, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        // 仅当这批事件涉及目标文件时才重建。
        if events.iter().any(|e| targets.contains(&e.path)) && load_into(&primary, &entries) {
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
    fn account_bookmarks_load_when_local_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AccountBookmarks"), BOOKMARKS_V1).unwrap();

        let store = BookmarkStore::open(dir.path().join("Bookmarks"));
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn local_and_account_bookmarks_merge_without_exact_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Bookmarks"), BOOKMARKS_V1).unwrap();
        std::fs::write(dir.path().join("AccountBookmarks"), BOOKMARKS_V2).unwrap();

        let store = BookmarkStore::open(dir.path().join("Bookmarks"));
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn merge_preserves_distinct_bookmarks_with_the_same_url() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Bookmarks"), BOOKMARKS_V1).unwrap();
        let account = BOOKMARKS_V1.replace("GitHub", "GitHub account");
        std::fs::write(dir.path().join("AccountBookmarks"), account).unwrap();

        let store = BookmarkStore::open(dir.path().join("Bookmarks"));
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn unreadable_account_file_preserves_previous_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("Bookmarks");
        std::fs::write(&local, BOOKMARKS_V1).unwrap();
        let store = BookmarkStore::open(&local);
        assert_eq!(store.len(), 1);

        std::fs::write(&local, BOOKMARKS_V2).unwrap();
        std::fs::create_dir(dir.path().join("AccountBookmarks")).unwrap();
        store.reload();
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn malformed_account_file_preserves_previous_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let account = dir.path().join("AccountBookmarks");
        std::fs::write(&account, BOOKMARKS_V1).unwrap();
        let store = BookmarkStore::open(dir.path().join("Bookmarks"));
        assert_eq!(store.len(), 1);

        std::fs::write(&account, "invalid json").unwrap();
        store.reload();
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn watcher_tracks_account_creation_updates_and_removal() {
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("Bookmarks");
        let account = dir.path().join("AccountBookmarks");
        std::fs::write(&local, BOOKMARKS_V1).unwrap();
        let entries: BookmarkEntries = Arc::default();
        let source = Arc::clone(&entries);
        let (sender, receiver) = std::sync::mpsc::channel();
        let _store = BookmarkStore::open_shared_with(&local, entries, move || {
            sender.send(source.read().unwrap().len()).unwrap();
        });
        let wait_for_count = |expected| {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if receiver
                    .recv_timeout(remaining)
                    .unwrap_or_else(|err| panic!("waiting for {expected} bookmarks: {err}"))
                    == expected
                {
                    break;
                }
            }
        };
        wait_for_count(1);

        std::fs::write(&account, BOOKMARKS_V2).unwrap();
        std::fs::remove_file(&local).unwrap();
        wait_for_count(2);

        let temporary = dir.path().join("AccountBookmarks.tmp");
        std::fs::write(&temporary, BOOKMARKS_V1).unwrap();
        std::fs::rename(&temporary, &account).unwrap();
        wait_for_count(1);

        std::fs::remove_file(&account).unwrap();
        wait_for_count(0);
    }

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
