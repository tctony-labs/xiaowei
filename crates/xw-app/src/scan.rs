//! 扫描 `.app` bundle，读 `Info.plist` 扁平化为 [`AppEntry`]。
//!
//! 只扫应用；系统设置面板不在此（现代 macOS 的 `.prefPane` 已是空壳，改由 host 侧内置清单提供）。

use std::path::{Path, PathBuf};

use crate::entry::{AppEntry, AppKind};

/// 应用目录向下额外递归的层数（覆盖 `/Applications/Utilities/*.app` 这类一层子目录）。
const APP_SUBDIR_DEPTH: u32 = 1;

/// bundle id → 搜索别名。应用更名但需保留旧名搜索时在此补充。
const HARDCODED_ALIAS_MAP: &[(&str, &[&str])] = &[("com.openai.codex", &["codex"])];

fn aliases_for(bundle_id: &str) -> Vec<String> {
    HARDCODED_ALIAS_MAP
        .iter()
        .find_map(|(id, aliases)| (*id == bundle_id).then_some(*aliases))
        .unwrap_or_default()
        .iter()
        .map(|alias| (*alias).to_string())
        .collect()
}

/// 扫描应用目录（`.app`），返回扁平条目列表。
pub fn scan_apps(app_dirs: &[PathBuf]) -> Vec<AppEntry> {
    let mut out = Vec::new();
    for dir in app_dirs {
        collect_bundles(dir, APP_SUBDIR_DEPTH, &mut out);
    }
    out
}

/// 遍历 `dir`：命中 `.app` 的目录当作 bundle 读入；否则在 `subdir_depth>0` 时下钻子目录。
fn collect_bundles(dir: &Path, subdir_depth: u32, out: &mut Vec<AppEntry>) {
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        let is_bundle = path.extension().and_then(|e| e.to_str()) == Some("app");
        if is_bundle {
            if let Some(app) = read_bundle(&path) {
                out.push(app);
            }
        } else if subdir_depth > 0 && path.is_dir() {
            collect_bundles(&path, subdir_depth - 1, out);
        }
    }
}

/// 读取 bundle 的 `Contents/Info.plist`，取展示名 / bundle id；读不到名字时回退文件名。
fn read_bundle(path: &Path) -> Option<AppEntry> {
    let mut name = String::new();
    let mut bundle_id = String::new();

    let plist_path = path.join("Contents/Info.plist");
    if let Ok(value) = plist::Value::from_file(&plist_path) {
        if let Some(dict) = value.as_dictionary() {
            name = dict
                .get("CFBundleDisplayName")
                .or_else(|| dict.get("CFBundleName"))
                .and_then(|v| v.as_string())
                .map(str::to_string)
                .unwrap_or_default();
            bundle_id = dict
                .get("CFBundleIdentifier")
                .and_then(|v| v.as_string())
                .map(str::to_string)
                .unwrap_or_default();
        }
    }

    if name.trim().is_empty() {
        name = path.file_stem()?.to_string_lossy().into_owned();
    }
    let aliases = aliases_for(&bundle_id);

    Some(AppEntry {
        name,
        path: path.to_path_buf(),
        bundle_id,
        aliases,
        kind: AppKind::Application,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个最小 `.app`：`Contents/Info.plist`（XML plist）带展示名与 bundle id。
    fn make_app(root: &Path, dir_name: &str, display: &str, bundle_id: &str) -> PathBuf {
        let app = root.join(dir_name);
        let contents = app.join("Contents");
        std::fs::create_dir_all(&contents).unwrap();
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>{display}</string>
  <key>CFBundleIdentifier</key><string>{bundle_id}</string>
</dict></plist>"#
        );
        std::fs::write(contents.join("Info.plist"), plist).unwrap();
        app
    }

    #[test]
    fn scan_reads_display_name_and_bundle_id() {
        let tmp = tempfile::tempdir().unwrap();
        make_app(tmp.path(), "微信.app", "微信", "com.tencent.xinWeChat");

        let apps = scan_apps(&[tmp.path().to_path_buf()]);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].name, "微信");
        assert_eq!(apps[0].bundle_id, "com.tencent.xinWeChat");
        assert!(apps[0].aliases.is_empty());
        assert_eq!(apps[0].kind, AppKind::Application);
    }

    #[test]
    fn scan_populates_hardcoded_aliases() {
        let tmp = tempfile::tempdir().unwrap();
        make_app(tmp.path(), "ChatGPT.app", "ChatGPT", "com.openai.codex");

        let apps = scan_apps(&[tmp.path().to_path_buf()]);
        assert_eq!(apps[0].aliases, ["codex"]);
    }

    #[test]
    fn scan_falls_back_to_file_stem_without_plist() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("Foo.app/Contents")).unwrap();

        let apps = scan_apps(&[tmp.path().to_path_buf()]);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].name, "Foo");
        assert!(apps[0].bundle_id.is_empty());
    }

    #[test]
    fn scan_descends_one_subdir_level() {
        let tmp = tempfile::tempdir().unwrap();
        let utils = tmp.path().join("Utilities");
        std::fs::create_dir_all(&utils).unwrap();
        make_app(&utils, "Terminal.app", "终端", "com.apple.Terminal");

        let apps = scan_apps(&[tmp.path().to_path_buf()]);
        assert!(apps.iter().any(|a| a.name == "终端"));
    }

    #[test]
    fn scan_missing_dir_yields_empty() {
        let apps = scan_apps(&[PathBuf::from("/no/such/dir")]);
        assert!(apps.is_empty());
    }
}
