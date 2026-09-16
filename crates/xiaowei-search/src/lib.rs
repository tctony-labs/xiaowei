//! Launcher 全局搜索核心。数据源与匹配不依赖 Electron 或 napi。
pub use xw_platform::app_icon::read_app_icon;
mod calculator;
mod commands;
pub use xw_platform::appearance::toggle_dark_mode;
mod pinyin;
mod scoring;
#[cfg(target_os = "macos")]
mod settings;
mod usage;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use xw_app::{AppEntries, AppEntry, AppKind, AppStore};
use xw_bookmark::{BookmarkEntries, BookmarkStore};

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    CopyText(String),
    OpenUrl(String),
    LaunchApp(String),
    RunCommand(String),
}

#[derive(Clone, Debug)]
pub struct SearchHit {
    pub id: String,
    pub recency_key: String,
    pub title: String,
    pub provider: String,
    pub label: String,
    pub score: f32,
    pub ranges: Vec<[u32; 2]>,
    pub action: Action,
}

struct IndexedApp {
    entry: AppEntry,
    stable_key: String,
    pinyin_haystacks: Vec<String>,
}

struct IndexedBookmark {
    title: String,
    url: String,
    pinyin: Vec<String>,
}

pub struct SearchEngine {
    apps: Arc<RwLock<Vec<IndexedApp>>>,
    bookmarks: Arc<RwLock<Vec<IndexedBookmark>>>,
    usage: usage::UsageStore,
    _apps_store: AppStore,
    _bookmarks_store: Option<BookmarkStore>,
}

impl SearchEngine {
    pub fn open_default() -> Self {
        let dirs = if cfg!(target_os = "macos") {
            xw_app::application_dirs()
        } else {
            Vec::new()
        };
        Self::open(dirs, xw_bookmark::default_chrome_bookmarks_path())
    }

    pub fn open(app_dirs: Vec<PathBuf>, bookmarks_path: Option<PathBuf>) -> Self {
        let apps = Arc::new(RwLock::new(Vec::new()));
        let raw_apps: AppEntries = Arc::default();
        let app_index = Arc::clone(&apps);
        let app_source = Arc::clone(&raw_apps);
        let apps_store = AppStore::open_shared_with(app_dirs, raw_apps, move || {
            let Ok(raw) = app_source.read() else { return };
            let mut items: Vec<_> = raw
                .iter()
                .cloned()
                .map(|mut entry| {
                    #[cfg(target_os = "macos")]
                    if let Some(name) = xw_platform::app_name::localized_name(&entry.path) {
                        if name != entry.name {
                            entry.aliases.push(entry.name.clone());
                        }
                        entry.name = name;
                    }
                    let haystacks = std::iter::once(entry.name.as_str())
                        .chain(entry.aliases.iter().map(String::as_str))
                        .flat_map(pinyin::haystacks)
                        .collect();
                    IndexedApp {
                        stable_key: entry.stable_key(),
                        entry,
                        pinyin_haystacks: haystacks,
                    }
                })
                .collect();
            #[cfg(target_os = "macos")]
            items.extend(settings::catalog_items());
            items.sort_by(|a, b| a.entry.name.cmp(&b.entry.name).then(a.entry.path.cmp(&b.entry.path)));
            let mut seen = HashSet::new();
            items.retain(|item| seen.insert(item.stable_key.clone()));
            if let Ok(mut index) = app_index.write() {
                *index = items;
            }
        });
        let bookmarks = Arc::new(RwLock::new(Vec::new()));
        let bookmark_index = Arc::clone(&bookmarks);
        let bookmarks_store = bookmarks_path.map(|path| {
            let raw: BookmarkEntries = Arc::default();
            let source = Arc::clone(&raw);
            BookmarkStore::open_shared_with(path, raw, move || {
                let Ok(raw) = source.read() else { return };
                let mut items: Vec<_> = raw
                    .iter()
                    .map(|entry| {
                        let title = if entry.name.trim().is_empty() {
                            entry.url.clone()
                        } else {
                            entry.name.clone()
                        };
                        IndexedBookmark {
                            pinyin: pinyin::haystacks(&title),
                            title,
                            url: entry.url.clone(),
                        }
                    })
                    .collect();
                items.sort_by(|a, b| a.title.cmp(&b.title).then(a.url.cmp(&b.url)));
                if let Ok(mut index) = bookmark_index.write() {
                    *index = items;
                }
            })
        });
        Self {
            apps,
            bookmarks,
            usage: usage::UsageStore::new(),
            _apps_store: apps_store,
            _bookmarks_store: bookmarks_store,
        }
    }

    pub fn record_usage(&self, id: &str) {
        self.usage.record(id);
    }

    pub fn search(&self, query: &str) -> Vec<SearchHit> {
        self.search_with_development(query, false)
    }

    pub fn search_with_development(&self, query: &str, development: bool) -> Vec<SearchHit> {
        let query = query.trim();
        if query.is_empty() || query.len() > 4096 {
            return Vec::new();
        }
        let mut scorer = scoring::FuzzyScorer::new(query);
        let mut hits = Vec::new();
        if let Ok(items) = self.bookmarks.read() {
            for (index, item) in items.iter().enumerate() {
                if let Some(score) = scorer.best(
                    [item.title.as_str(), item.url.as_str()],
                    item.pinyin.iter().map(String::as_str),
                ) {
                    hits.push(SearchHit {
                        id: format!("bookmark:{index}:{}", item.url),
                        recency_key: format!("bookmark:{}", item.url),
                        title: item.title.clone(),
                        provider: "bookmark".into(),
                        label: "网页".into(),
                        score,
                        ranges: Vec::new(),
                        action: Action::OpenUrl(item.url.clone()),
                    });
                }
            }
        }
        if let Ok(items) = self.apps.read() {
            for item in items.iter() {
                let entry = &item.entry;
                let base = std::iter::once(entry.name.as_str()).chain(entry.aliases.iter().map(String::as_str));
                if let Some(score) = scorer.best(base, item.pinyin_haystacks.iter().map(String::as_str)) {
                    let (label, action) = if entry.kind == AppKind::PreferencePane {
                        (
                            "系统设置",
                            Action::OpenUrl(format!("x-apple.systempreferences:{}", entry.bundle_id)),
                        )
                    } else {
                        ("应用", Action::LaunchApp(entry.path.to_string_lossy().into_owned()))
                    };
                    hits.push(SearchHit {
                        id: format!("app:{}", item.stable_key),
                        recency_key: format!("app:{}", item.stable_key),
                        title: entry.name.clone(),
                        provider: "app".into(),
                        label: label.into(),
                        score,
                        ranges: Vec::new(),
                        action,
                    });
                }
            }
        }
        // Each provider selects its top 20 by base match before recency weighting.
        let (mut bookmarks, mut apps): (Vec<_>, Vec<_>) = hits.into_iter().partition(|hit| hit.provider == "bookmark");
        for provider in [&mut bookmarks, &mut apps] {
            provider.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.title.cmp(&b.title)));
            provider.truncate(20);
        }
        let mut command_hits = commands::search(query, development);
        command_hits.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.title.cmp(&b.title)));
        command_hits.truncate(10);
        command_hits.extend(bookmarks);
        command_hits.extend(apps);
        let mut ranked: Vec<_> = command_hits
            .into_iter()
            .map(|hit| {
                let rank = hit.score * (1.0 + 0.6 * self.usage.factor(&hit.recency_key));
                (hit, rank)
            })
            .collect();
        ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
        let mut hits: Vec<_> = ranked.into_iter().map(|(hit, _)| hit).collect();
        hits.truncate(30);
        for hit in &mut hits {
            hit.ranges = scorer
                .highlight_ranges(&hit.title)
                .into_iter()
                .map(|(a, b)| [a, b])
                .collect();
        }
        if let Some((title, value)) = calculator::calculate(query) {
            hits.insert(
                0,
                SearchHit {
                    id: "calculator".into(),
                    recency_key: String::new(),
                    title,
                    provider: "calculator".into(),
                    label: "计算器".into(),
                    score: 0.0,
                    ranges: Vec::new(),
                    action: Action::CopyText(value),
                },
            );
        }
        hits.truncate(30);
        hits
    }
}
