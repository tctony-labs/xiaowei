//! Typed settings, backed by the existing per-key meta entries.

pub mod gateway;

use crate::Database;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;
use xw_contracts::xiaowei::storage::{
    update_settings_request::Change, KvEntry, KvPrefix, SettingsChanged, SettingsSnapshot, ShortcutBinding,
    ShortcutConfiguration, ThemeMode, UpdateSettingsRequest,
};

const PREFIX: &str = "setting.";

pub type ApplyFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type Apply = Arc<dyn Fn(SettingsSnapshot, SettingsSnapshot) -> ApplyFuture + Send + Sync>;
type Publish = Arc<dyn Fn(SettingsChanged) + Send + Sync>;

#[derive(Debug)]
pub enum SettingsError {
    InvalidArgument(&'static str),
    Operation(String),
}

impl fmt::Display for SettingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidArgument(message) => formatter.write_str(message),
            Self::Operation(message) => formatter.write_str(message),
        }
    }
}

pub struct SettingsService {
    database: Arc<Database>,
    platform: String,
    apply: Apply,
    publish: Mutex<Option<Publish>>,
    updates: AsyncMutex<()>,
}

impl SettingsService {
    pub fn new(database: Arc<Database>, platform: String) -> Self {
        Self::with_apply(
            database,
            platform,
            Arc::new(|previous, next| Box::pin(gateway::apply(previous, next))),
        )
    }

    pub(crate) fn with_apply(database: Arc<Database>, platform: String, apply: Apply) -> Self {
        Self {
            database,
            platform,
            apply,
            publish: Mutex::new(None),
            updates: AsyncMutex::new(()),
        }
    }

    pub fn set_publisher(&self, publish: Publish) {
        *self.publish.lock().unwrap() = Some(publish);
    }

    pub async fn get(&self) -> Result<SettingsSnapshot, String> {
        let _guard = self.updates.lock().await;
        self.load().await
    }

    async fn load(&self) -> Result<SettingsSnapshot, String> {
        let entries = self
            .database
            .meta_list(KvPrefix { prefix: PREFIX.into() })
            .await
            .map_err(|error| error.to_string())?;
        let mut snapshot = defaults(&self.platform);
        for entry in entries.entries {
            let Some(name) = entry.key.strip_prefix(PREFIX) else {
                continue;
            };
            let Ok(value) = serde_json::from_str(&entry.json) else {
                continue;
            };
            apply_stored(&mut snapshot, name, value);
        }
        Ok(snapshot)
    }

    pub async fn update(&self, request: UpdateSettingsRequest) -> Result<SettingsSnapshot, SettingsError> {
        let _guard = self.updates.lock().await;
        let previous = self.load().await.map_err(SettingsError::Operation)?;
        let (next, key, value) = changed(&previous, request).map_err(SettingsError::InvalidArgument)?;

        if let Err(error) = (self.apply)(previous.clone(), next.clone()).await {
            (self.apply)(next, previous).await.map_err(|rollback| {
                SettingsError::Operation(format!(
                    "Settings change failed: {error}; system rollback failed: {rollback}"
                ))
            })?;
            return Err(SettingsError::Operation(error));
        }
        let result = self
            .database
            .meta_set(KvEntry {
                key: format!("{PREFIX}{key}"),
                json: value.to_string(),
            })
            .await;
        if let Err(error) = result {
            (self.apply)(next, previous).await.map_err(|rollback| {
                SettingsError::Operation(format!(
                    "Settings save failed: {error}; system rollback failed: {rollback}"
                ))
            })?;
            return Err(SettingsError::Operation(error.to_string()));
        }

        if let Some(publish) = self.publish.lock().unwrap().as_ref() {
            publish(SettingsChanged {
                snapshot: Some(next.clone()),
            });
        }
        Ok(next)
    }
}

fn defaults(platform: &str) -> SettingsSnapshot {
    let main = if platform == "darwin" {
        vec!["Meta", "Space"]
    } else {
        vec!["Control", "Alt", "Space"]
    };
    let clipboard = vec![if platform == "darwin" { "Meta" } else { "Control" }, "Shift", "KeyX"];
    SettingsSnapshot {
        theme: ThemeMode::System as i32,
        autostart: false,
        include_chrome_bookmarks: true,
        shortcuts: Some(ShortcutConfiguration {
            main: Some(ShortcutBinding {
                keys: main.into_iter().map(str::to_owned).collect(),
            }),
            clipboard: Some(ShortcutBinding {
                keys: clipboard.into_iter().map(str::to_owned).collect(),
            }),
            quick_chat: None,
        }),
        clipboard_enabled: true,
        clipboard_auto_paste: false,
        clipboard_retention_days: 30,
    }
}

fn binding(value: &Value) -> Option<Option<ShortcutBinding>> {
    if value.is_null() {
        return Some(None);
    }
    let keys = value.as_array()?;
    let keys = keys
        .iter()
        .map(|key| key.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()?;
    Some(Some(ShortcutBinding { keys }))
}

fn shortcuts_from_json(value: &Value, fallback: &ShortcutConfiguration) -> Option<ShortcutConfiguration> {
    let object = value.as_object()?;
    let config = ShortcutConfiguration {
        main: object.get("main").map(binding).unwrap_or(Some(fallback.main.clone()))?,
        clipboard: object
            .get("clipboard")
            .map(binding)
            .unwrap_or(Some(fallback.clipboard.clone()))?,
        quick_chat: object.get("quickChat").map(binding).unwrap_or(Some(None))?,
    };
    valid_shortcuts(&config).then_some(config)
}

fn valid_binding(binding: &ShortcutBinding) -> bool {
    let keys = &binding.keys;
    if !(2..=5).contains(&keys.len()) {
        return false;
    }
    let mut seen = HashSet::new();
    if !keys.iter().all(|key| seen.insert(key)) {
        return false;
    }
    if !keys[..keys.len() - 1]
        .iter()
        .all(|key| matches!(key.as_str(), "Meta" | "Control" | "Alt" | "Shift"))
    {
        return false;
    }
    let last = keys.last().unwrap().as_str();
    let bytes = last.as_bytes();
    matches!(
        last,
        "Space"
            | "BracketLeft"
            | "BracketRight"
            | "Backslash"
            | "Semicolon"
            | "Quote"
            | "Comma"
            | "Period"
            | "Slash"
            | "Minus"
            | "Equal"
            | "Backquote"
            | "ArrowUp"
            | "ArrowDown"
            | "ArrowLeft"
            | "ArrowRight"
            | "Tab"
            | "Backspace"
            | "Delete"
            | "Home"
            | "End"
            | "Enter"
            | "Escape"
            | "PageUp"
            | "PageDown"
    ) || (bytes.len() == 4 && bytes.starts_with(b"Key") && bytes[3].is_ascii_uppercase())
        || (bytes.len() == 6 && bytes.starts_with(b"Digit") && bytes[5].is_ascii_digit())
        || (last.strip_prefix('F').is_some_and(|number| {
            number
                .parse::<u8>()
                .is_ok_and(|value| (1..=12).contains(&value) && number == value.to_string())
        }))
}

fn valid_shortcuts(config: &ShortcutConfiguration) -> bool {
    let mut assigned = HashSet::new();
    for binding in [&config.main, &config.clipboard, &config.quick_chat]
        .into_iter()
        .flatten()
    {
        if !valid_binding(binding) {
            return false;
        }
        let mut keys = binding.keys.clone();
        keys.sort();
        if !assigned.insert(keys) {
            return false;
        }
    }
    true
}

fn shortcuts_json(config: &ShortcutConfiguration) -> Value {
    let keys = |binding: &Option<ShortcutBinding>| binding.as_ref().map(|binding| binding.keys.clone());
    json!({
        "main": keys(&config.main),
        "clipboard": keys(&config.clipboard),
        "quickChat": keys(&config.quick_chat),
    })
}

fn apply_stored(snapshot: &mut SettingsSnapshot, name: &str, value: Value) {
    match name {
        "theme" => {
            snapshot.theme = match value.as_str() {
                Some("system") => ThemeMode::System as i32,
                Some("light") => ThemeMode::Light as i32,
                Some("dark") => ThemeMode::Dark as i32,
                _ => return,
            }
        }
        "autostart" => {
            if let Some(value) = value.as_bool() {
                snapshot.autostart = value;
            }
        }
        "enableOpenBookmark" => {
            if let Some(value) = value.as_bool() {
                snapshot.include_chrome_bookmarks = value;
            }
        }
        "shortcuts" => {
            if let Some(value) = shortcuts_from_json(&value, snapshot.shortcuts.as_ref().unwrap()) {
                snapshot.shortcuts = Some(value);
            }
        }
        "clipboardEnabled" => {
            if let Some(value) = value.as_bool() {
                snapshot.clipboard_enabled = value;
            }
        }
        "clipboardAutoPaste" => {
            if let Some(value) = value.as_bool() {
                snapshot.clipboard_auto_paste = value;
            }
        }
        "clipboardRetentionDays" => {
            if let Some(value) = value.as_i64().filter(|value| matches!(value, 1 | 7 | 15 | 30 | -1)) {
                snapshot.clipboard_retention_days = value as i32;
            }
        }
        _ => {}
    }
}

fn changed(
    previous: &SettingsSnapshot,
    request: UpdateSettingsRequest,
) -> Result<(SettingsSnapshot, &'static str, Value), &'static str> {
    let mut next = previous.clone();
    let (key, value) = match request.change.ok_or("Missing setting change")? {
        Change::Theme(theme) => {
            let name = match ThemeMode::try_from(theme) {
                Ok(ThemeMode::System) => "system",
                Ok(ThemeMode::Light) => "light",
                Ok(ThemeMode::Dark) => "dark",
                _ => return Err("Invalid theme"),
            };
            next.theme = theme;
            ("theme", json!(name))
        }
        Change::Autostart(value) => {
            next.autostart = value;
            ("autostart", json!(value))
        }
        Change::IncludeChromeBookmarks(value) => {
            next.include_chrome_bookmarks = value;
            ("enableOpenBookmark", json!(value))
        }
        Change::Shortcuts(value) => {
            if !valid_shortcuts(&value) {
                return Err("Invalid shortcuts");
            }
            let json = shortcuts_json(&value);
            next.shortcuts = Some(value);
            ("shortcuts", json)
        }
        Change::ClipboardEnabled(value) => {
            next.clipboard_enabled = value;
            ("clipboardEnabled", json!(value))
        }
        Change::ClipboardAutoPaste(value) => {
            next.clipboard_auto_paste = value;
            ("clipboardAutoPaste", json!(value))
        }
        Change::ClipboardRetentionDays(value) => {
            if !matches!(value, 1 | 7 | 15 | 30 | -1) {
                return Err("Invalid retention");
            }
            next.clipboard_retention_days = value;
            ("clipboardRetentionDays", json!(value))
        }
    };
    Ok((next, key, value))
}
