use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime},
};

use xw_agent_runtime::{resources::ResourceCache, tools::command};

fn write(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

fn modified(path: &Path, seconds: u64) {
    fs::File::open(path)
        .unwrap()
        .set_times(
            fs::FileTimes::new()
                .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)),
        )
        .unwrap();
}

#[test]
fn rules_are_ordered_scoped_and_nonrecursive_and_commands_use_project_override() {
    let user = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    write(&user.path().join("AGENTS.md"), "user top");
    write(&user.path().join("CLAUDE.md"), "not automatically loaded");
    write(&user.path().join("rules/z.md"), "last");
    write(&user.path().join("rules/a.md"), "first");
    write(&user.path().join("rules/sub/ignored.md"), "nested");
    write(&user.path().join("rules/ignored.txt"), "other extension");
    write(&project.path().join("AGENTS.md"), "project top");
    write(&project.path().join(".xiaowei/rules/p.md"), "project rule");
    write(&user.path().join("commands/周报.md"), "user command");
    write(
        &project.path().join(".xiaowei/commands/周报.md"),
        "---\ndescription: |\n  整理周报\n  按模块归纳\nextra: ignored\n---\nproject command",
    );
    write(&user.path().join("commands/plain.md"), "plain body");

    let snapshot = ResourceCache::default().snapshot(Some(user.path()), Some(project.path()));
    let keys: Vec<_> = snapshot
        .rules
        .iter()
        .map(|rule| rule.key.as_str())
        .collect();
    assert_eq!(
        keys,
        [
            "rules.user.AGENTS.md",
            "rules.user.rules/a.md",
            "rules.user.rules/z.md",
            "rules.project.AGENTS.md",
            "rules.project.rules/p.md"
        ]
    );
    assert_eq!(snapshot.commands["周报"].body.text, "project command");
    assert!(
        snapshot.commands["周报"]
            .body
            .description
            .as_ref()
            .unwrap()
            .contains("按模块")
    );
    assert!(snapshot.commands["plain"].body.description.is_none());
    assert_eq!(snapshot.commands["周报"].scope.name(), "project");
}

#[test]
fn redirect_dependencies_are_refreshed_deduplicated_and_cycles_terminate() {
    let root = tempfile::tempdir().unwrap();
    write(&root.path().join("AGENTS.md"), "@rules/shared.md");
    let shared = root.path().join("rules/shared.md");
    write(&shared, "version1");
    modified(&shared, 100);
    write(&root.path().join("rules/literal.md"), "@unchanged-literal");
    let mut cache = ResourceCache::default();
    let first = cache.snapshot(Some(root.path()), None);
    assert_eq!(first.rules.len(), 2);
    assert_eq!(first.rules[0].file.text, "version1");
    assert_eq!(first.rules[1].file.text, "@unchanged-literal");
    write(&shared, "version2");
    modified(&shared, 200);
    let second = cache.snapshot(Some(root.path()), None);
    assert_eq!(second.rules[0].file.text, "version2");
    assert_eq!(first.rules[0].file.text, "version1");

    write(&root.path().join("AGENTS.md"), "@loop.md");
    write(&root.path().join("loop.md"), "@AGENTS.md");
    let cyclic = cache.snapshot(Some(root.path()), None);
    assert!(
        cyclic
            .rules
            .iter()
            .all(|rule| rule.key != "rules.user.AGENTS.md")
    );
}

#[test]
fn command_snapshots_stay_fixed_and_invalid_files_do_not_keep_stale_bodies() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("commands/guide.md");
    write(&path, "---\r\ndescription: Guide\r\n---\r\nBODY-V1");
    modified(&path, 100);
    write(
        &root.path().join("commands/bad.md"),
        "---\ndescription: [\n---\nbody",
    );
    write(&root.path().join("commands/empty.md"), "  ");
    write(&root.path().join("commands/bad name.md"), "body");
    write(&root.path().join("commands/sub/ignored.md"), "body");
    let mut cache = ResourceCache::default();
    let first = cache.snapshot(Some(root.path()), None);
    assert_eq!(first.commands.len(), 1);
    let loaded = command::execute(&first.commands, r#"{"name":"guide"}"#).unwrap();
    assert!(loaded.text.contains("BODY-V1"));
    assert!(!loaded.text.contains("description:"));
    let metadata: serde_json::Value = serde_json::from_str(&loaded.metadata_json.unwrap()).unwrap();
    assert_eq!(metadata["command"]["name"], "guide");

    write(&path, "BODY-V2");
    modified(&path, 200);
    let second = cache.snapshot(Some(root.path()), None);
    assert!(
        command::execute(&second.commands, r#"{"name":"guide"}"#)
            .unwrap()
            .text
            .contains("BODY-V2")
    );
    assert!(
        command::execute(&first.commands, r#"{"name":"guide"}"#)
            .unwrap()
            .text
            .contains("BODY-V1")
    );
    assert!(command::execute(&second.commands, r#"{"name":"missing"}"#).is_err());
    assert!(command::execute(&second.commands, r#"{"name":"guide","path":"/tmp"}"#).is_err());

    write(&path, "---\ndescription: broken");
    let invalid = cache.snapshot(Some(root.path()), None);
    assert!(invalid.commands.is_empty());
    write(&path, "BODY-V3");
    let restored = cache.snapshot(Some(root.path()), None);
    assert_eq!(restored.commands["guide"].body.text, "BODY-V3");
    fs::rename(&path, root.path().join("commands/renamed.md")).unwrap();
    let renamed = cache.snapshot(Some(root.path()), None);
    assert!(!renamed.commands.contains_key("guide"));
    assert!(renamed.commands.contains_key("renamed"));
}

#[cfg(unix)]
#[test]
fn symlink_retarget_is_detected_even_with_equal_mtime_and_size() {
    let root = tempfile::tempdir().unwrap();
    let first = root.path().join("first");
    let second = root.path().join("second");
    write(&first, "first");
    write(&second, "other");
    modified(&first, 100);
    modified(&second, 100);
    let link = root.path().join("AGENTS.md");
    std::os::unix::fs::symlink(&first, &link).unwrap();
    let mut cache = ResourceCache::default();
    assert_eq!(
        cache.snapshot(Some(root.path()), None).rules[0].file.text,
        "first"
    );
    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&second, &link).unwrap();
    assert_eq!(
        cache.snapshot(Some(root.path()), None).rules[0].file.text,
        "other"
    );
}

#[test]
fn oversized_command_fails_without_truncating_or_reporting_success() {
    let root = tempfile::tempdir().unwrap();
    write(
        &root.path().join("commands/large.md"),
        &"x".repeat(64 * 1024),
    );
    let snapshot = ResourceCache::default().snapshot(Some(root.path()), None);
    assert!(
        command::execute(&snapshot.commands, r#"{"name":"large"}"#)
            .unwrap_err()
            .contains("64 KiB")
    );
    assert!(
        ResourceCache::default()
            .snapshot(None, None)
            .rules
            .is_empty()
    );
}
