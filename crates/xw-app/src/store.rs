//! 加载应用列表 + `notify` 监听扫描目录，变更时自动重扫写回共享句柄。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};

use crate::entry::AppEntries;
use crate::scan::scan_apps;

/// 目录事件 debounce 窗口：拖入 / 卸载一个 `.app` 会炸出一连串文件事件，攒批后只重扫一次；
/// 应用增删本就低频，稍长的窗口不影响体感。
const WATCH_DEBOUNCE: Duration = Duration::from_millis(500);

/// 应用列表存储：持有共享列表与各扫描目录的 debouncer（内含 watcher）。随 store drop 而停止。
pub struct AppStore {
    _watchers: Vec<Debouncer<RecommendedWatcher>>,
}

impl AppStore {
    /// 用外部共享句柄打开：立即扫描一次并启动监听，之后目录变更自动重扫写回同一句柄，
    /// 并在**每次扫描后**（初次 + 变更）调用 `on_change`（使用方据此重建派生索引，如拼音 / 图标）。
    pub fn open_shared_with<F>(app_dirs: Vec<PathBuf>, entries: AppEntries, on_change: F) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        let on_change = Arc::new(on_change);

        // 统一的「重扫 → 写回 → 通知」闭包，初次与每次监听回调都复用它。
        let rescan: Arc<dyn Fn() + Send + Sync> = {
            let app_dirs = app_dirs.clone();
            let entries = Arc::clone(&entries);
            let on_change = Arc::clone(&on_change);
            Arc::new(move || {
                let apps = scan_apps(&app_dirs);
                if let Ok(mut guard) = entries.write() {
                    *guard = apps;
                }
                on_change();
            })
        };

        rescan();

        let mut watchers = Vec::new();
        for dir in app_dirs {
            if !dir.exists() {
                continue;
            }
            if let Some(watcher) = start_watcher(&dir, Arc::clone(&rescan)) {
                watchers.push(watcher);
            }
        }

        Self { _watchers: watchers }
    }
}

/// 递归监听扫描目录；debounce 窗口内的事件攒成一批，只触发一次全量重扫
/// （应用增删频率低，无需精细 diff）。
fn start_watcher(dir: &std::path::Path, rescan: Arc<dyn Fn() + Send + Sync>) -> Option<Debouncer<RecommendedWatcher>> {
    let mut debouncer = new_debouncer(WATCH_DEBOUNCE, move |res: DebounceEventResult| {
        if res.is_ok() {
            rescan();
        }
    })
    .ok()?;

    if debouncer.watcher().watch(dir, RecursiveMode::Recursive).is_err() {
        return None;
    }
    Some(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::RwLock;

    fn make_app(root: &std::path::Path, dir_name: &str) {
        let contents = root.join(dir_name).join("Contents");
        std::fs::create_dir_all(&contents).unwrap();
        std::fs::write(
            contents.join("Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>App</string>
</dict></plist>"#,
        )
        .unwrap();
    }

    #[test]
    fn initial_scan_writes_entries_and_fires_hook() {
        let tmp = tempfile::tempdir().unwrap();
        make_app(tmp.path(), "App.app");

        let calls = Arc::new(AtomicUsize::new(0));
        let entries: AppEntries = Arc::new(RwLock::new(Vec::new()));
        let calls_hook = Arc::clone(&calls);
        let _store = AppStore::open_shared_with(vec![tmp.path().to_path_buf()], Arc::clone(&entries), move || {
            calls_hook.fetch_add(1, Ordering::SeqCst);
        });

        assert_eq!(entries.read().unwrap().len(), 1);
        assert!(calls.load(Ordering::SeqCst) >= 1);
    }
}
