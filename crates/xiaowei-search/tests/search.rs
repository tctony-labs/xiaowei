use std::fs;
use xiaowei_search::{Action, SearchEngine};

#[test]
fn merges_calculator_bookmarks_and_apps_with_pinyin_and_highlight() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("微信.app/Contents");
    fs::create_dir_all(&app).unwrap();
    fs::write(
        app.join("Info.plist"),
        r#"<?xml version="1.0"?><plist version="1.0"><dict>
        <key>CFBundleName</key><string>微信</string>
        <key>CFBundleIdentifier</key><string>test.wechat</string></dict></plist>"#,
    )
    .unwrap();
    let bookmarks = dir.path().join("Bookmarks");
    fs::write(
        &bookmarks,
        r#"{"roots":{"bookmark_bar":{"type":"folder","name":"书签栏","children":[
        {"type":"url","name":"周报","url":"https://example.test/report"},
        {"type":"url","name":"重复周报","url":"https://example.test/report"},
        {"type":"url","name":"1+2","url":"https://example.test/math"}
    ]}}}"#,
    )
    .unwrap();
    let engine = SearchEngine::open(vec![dir.path().to_owned()], Some(bookmarks));
    assert!(engine.search(" ").is_empty());
    let hits = engine.search("zb");
    let report = hits.iter().find(|h| h.title == "周报").unwrap();
    assert_eq!(report.title, "周报");
    assert_eq!(report.ranges, vec![[0, 2]]);
    assert_eq!(hits.iter().filter(|h| h.id == report.id).count(), 1);
    let duplicates: Vec<_> = hits.iter().filter(|h| h.recency_key == report.recency_key).collect();
    assert_eq!(duplicates.len(), 2);
    assert_ne!(duplicates[0].id, duplicates[1].id);
    assert!(engine.search("wx").iter().any(|h| h.id == "app:test.wechat"));
    let hits = engine.search("1+2");
    assert_eq!(hits[0].provider, "calculator");
    assert_eq!(hits[0].action, Action::CopyText("3".into()));
    assert!(hits.iter().any(|h| h.provider == "bookmark"));
    assert!(!engine.search("42").iter().any(|h| h.provider == "calculator"));
    let url_match = engine.search("example.test/report");
    assert!(url_match.iter().find(|h| h.id == report.id).unwrap().ranges.is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn system_settings_match_alias_and_open_with_scheme() {
    let engine = SearchEngine::open(Vec::new(), None);
    let hits = engine.search("pingmu");
    let display = hits.iter().find(|h| h.title == "显示器").unwrap();
    assert!(matches!(&display.action, Action::OpenUrl(url) if url.starts_with("x-apple.systempreferences:")));
}

#[test]
fn provider_cutoff_precedes_recency_and_base_scores_are_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("Bookmarks");
    let rows: Vec<_> = (0..25)
        .map(|i| format!(r#"{{"type":"url","name":"match {i:02}","url":"https://example.test/{i:02}"}}"#))
        .collect();
    fs::write(
        &file,
        format!(
            r#"{{"roots":{{"bookmark_bar":{{"type":"folder","name":"test","children":[{}]}}}}}}"#,
            rows.join(",")
        ),
    )
    .unwrap();
    let engine = SearchEngine::open(Vec::new(), Some(file));
    let before = engine.search("match");
    assert_eq!(before.len(), 20);
    let promoted = &before[10];
    engine.record_usage(&promoted.recency_key);
    engine.record_usage("bookmark:https://example.test/24");
    let after = engine.search("match");
    assert_eq!(after[0].id, promoted.id);
    assert_eq!(after[0].score, promoted.score);
    assert!(!after.iter().any(|h| h.title == "match 24"));
}
