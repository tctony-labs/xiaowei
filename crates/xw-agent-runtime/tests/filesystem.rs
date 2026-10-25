use xw_agent_runtime::tools::FileTools;

use serde_json::json;
use std::{fs, path::Path, time::SystemTime};
use tokio_util::sync::CancellationToken;

#[test]
fn text_pagination_dedup_exact_edit_and_diff() {
    let root = tempfile::tempdir().unwrap();
    let mut tools = FileTools::new(root.path().into(), vec![], &[]);
    tools
        .execute("Write", r#"{"path":"a/file","contents":"a\nb\nb\nc\n"}"#)
        .unwrap();
    let read = tools
        .execute("Read", r#"{"path":"a/file","offset":2,"limit":2}"#)
        .unwrap();
    assert!(read.text.contains("2|b") && read.text.contains("3|b"));
    assert!(
        tools
            .execute("Read", r#"{"path":"a/file","offset":2,"limit":2}"#)
            .unwrap()
            .text
            .contains("unchanged")
    );
    assert!(
        tools
            .execute(
                "Edit",
                r#"{"path":"a/file","old_string":"b","new_string":"B"}"#
            )
            .is_err()
    );
    let edit = tools
        .execute(
            "Edit",
            r#"{"path":"a/file","old_string":"b","new_string":"B","replace_all":true}"#,
        )
        .unwrap();
    let metadata: serde_json::Value = serde_json::from_str(&edit.metadata_json.unwrap()).unwrap();
    assert_eq!(metadata["filediff"]["additions"], 2);
    assert_eq!(
        std::fs::read_to_string(root.path().join("a/file")).unwrap(),
        "a\nB\nB\nc\n"
    );
    assert!(
        !tools
            .execute("Read", r#"{"path":"a/file","offset":2,"limit":2}"#)
            .unwrap()
            .text
            .contains("unchanged")
    );
}

#[test]
fn rejects_bad_params_pdf_and_missing_files_with_optional_exception() {
    let root = tempfile::tempdir().unwrap();
    let mut tools = FileTools::new(root.path().into(), vec![], &[]);
    for args in [
        r#"{"path":4}"#,
        r#"{"path":"x","offset":0}"#,
        r#"{"path":"x","offset":-1}"#,
        r#"{"path":"x","limit":false}"#,
        r#"{"path":"x","extra":true}"#,
        r#"{"path":"x"}"#,
    ] {
        assert!(tools.execute("Read", args).is_err());
    }
    assert!(
        tools
            .execute("Read", r#"{"path":"x.PDF"}"#)
            .unwrap_err()
            .contains("PDF")
    );
    assert!(
        tools
            .execute("Read", r#"{"path":"x","allow_missing":true}"#)
            .is_ok()
    );
    assert!(!root.path().join("x").exists());
}

#[cfg(unix)]
#[test]
fn permission_follows_symlinks_and_checks_missing_ancestors_before_mkdir() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir_in(dirs::home_dir().unwrap()).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
    let mut tools = FileTools::new(root.path().into(), vec![], &[]);
    assert!(
        tools
            .execute(
                "Write",
                r#"{"path":"escape/new/sub/file","contents":"denied"}"#
            )
            .unwrap_err()
            .contains("权限不足")
    );
    assert!(!outside.path().join("new").exists());
    let granted = xw_agent_types::PermissionTarget {
        path: outside.path().to_str().unwrap().into(),
        is_directory: true,
    };
    let mut tools = FileTools::new(root.path().into(), vec![granted], &[]);
    tools
        .execute(
            "Write",
            r#"{"path":"escape/new/sub/file","contents":"allowed"}"#,
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(outside.path().join("new/sub/file")).unwrap(),
        "allowed"
    );
    tools
        .execute(
            "Write",
            r#"{"path":".git/hooks/test","contents":"allowed"}"#,
        )
        .unwrap();
}

#[test]
fn home_cwd_does_not_grant_home_tree_writes() {
    let home = dirs::home_dir().unwrap();
    let output = tempfile::tempdir_in(&home).unwrap();
    let path = output.path().join("new/sub/file");
    let mut tools = FileTools::new(home, vec![], &[]);
    let args = serde_json::json!({"path": path, "contents": "denied"}).to_string();
    assert!(
        tools
            .execute("Write", &args)
            .unwrap_err()
            .contains("权限不足")
    );
    assert!(!output.path().join("new").exists());
}

#[test]
fn output_is_bounded_and_tells_the_model_where_to_continue() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("large"), "a repeated line\n".repeat(10000)).unwrap();
    let mut tools = FileTools::new(root.path().into(), vec![], &[]);
    let output = tools.execute("Read", r#"{"path":"large"}"#).unwrap();
    assert!(output.text.len() < 65 * 1024);
    assert!(output.text.contains("continue with offset"));
}

fn fixture(root: &Path, path: &str, contents: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

#[test]
fn glob_preserves_recursive_hidden_and_excluded_directory_rules() {
    let root = tempfile::tempdir().unwrap();
    for path in [
        "a.rs",
        "src/b.rs",
        ".secret/c.rs",
        "node_modules/d.rs",
        "target/e.rs",
        ".cfg/.nested/settings.json",
        ".cfg/settings.json",
    ] {
        fixture(root.path(), path, "x");
    }
    fixture(root.path(), ".gitignore", "src/\n");
    let mut tools = FileTools::new(root.path().into(), vec![], &[]);
    let output = tools.execute("Glob", r#"{"pattern":"*.rs"}"#).unwrap();
    assert!(output.text.starts_with("2 file(s) found:"));
    assert!(output.text.contains("a.rs") && output.text.contains("src/b.rs"));
    for excluded in ["c.rs", "d.rs", "e.rs"] {
        assert!(!output.text.contains(excluded), "{}", output.text);
    }

    let output = tools.execute("Glob", r#"{"pattern":".cfg/**"}"#).unwrap();
    assert!(output.text.starts_with("1 file(s) found:"));
    assert!(output.text.contains(".cfg/settings.json"));
    assert!(!output.text.contains(".nested"));
    let output = tools
        .execute("Glob", r#"{"pattern":".cfg/.nested/settings.json"}"#)
        .unwrap();
    assert!(output.text.contains(".nested/settings.json"));
    assert!(
        tools
            .execute("Glob", r#"{"pattern":".*/*.rs"}"#)
            .unwrap()
            .text
            .starts_with("No files")
    );
    let output = tools
        .execute("Glob", r#"{"pattern":"*.json","path":".cfg"}"#)
        .unwrap();
    assert!(output.text.starts_with("1 file(s) found:"));
}

#[test]
fn glob_retains_the_newest_five_hundred_matches() {
    let root = tempfile::tempdir().unwrap();
    for index in 0..502 {
        let file = fs::File::create(root.path().join(format!("file-{index:03}.txt"))).unwrap();
        let modified = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1000 + index);
        file.set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }
    let mut tools = FileTools::new(root.path().into(), vec![], &[]);
    let output = tools.execute("Glob", r#"{"pattern":"*.txt"}"#).unwrap();
    assert!(output.text.starts_with("500 file(s) shown"));
    assert!(output.text.contains("502 total matches (truncated)"));
    assert!(
        output
            .text
            .lines()
            .nth(1)
            .unwrap()
            .ends_with("file-501.txt")
    );
    assert!(
        output
            .text
            .lines()
            .last()
            .unwrap()
            .ends_with("file-002.txt")
    );
    assert!(!output.text.contains("file-000.txt"));
    assert!(!output.text.contains("file-001.txt"));
    let metadata: serde_json::Value = serde_json::from_str(&output.metadata_json.unwrap()).unwrap();
    assert_eq!(metadata["search"]["matches"], 502);
    assert_eq!(metadata["search"]["truncated"], true);
}

#[test]
fn grep_preserves_ignore_rules_extension_filters_and_explicit_file_targets() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join(".git")).unwrap();
    fixture(
        root.path(),
        ".gitignore",
        "ignored.rs\n!node_modules/\n!node_modules/visible.rs\n",
    );
    fixture(root.path(), ".ignore", "local.rs\n");
    for path in [
        "src/a.rs",
        "src/b.tsx",
        "ignored.rs",
        "local.rs",
        ".hidden.rs",
        "node_modules/visible.rs",
        "target/visible.rs",
    ] {
        fixture(root.path(), path, "hello\nneedle 42\n");
    }
    let mut tools = FileTools::new(root.path().into(), vec![], &[]);
    let output = tools.execute("Grep", r#"{"pattern":"needle"}"#).unwrap();
    assert!(output.text.starts_with("4 match(es):"), "{}", output.text);
    assert!(!output.text.contains(".hidden.rs"));
    let output = tools
        .execute("Grep", r#"{"pattern":"^needle \\d+$","include":"*.rs"}"#)
        .unwrap();
    assert!(output.text.starts_with("4 match(es):"), "{}", output.text);
    assert!(output.text.contains("a.rs:2:needle 42"));
    assert!(
        output.text.contains("node_modules/visible.rs:2:needle 42"),
        "{}",
        output.text
    );
    assert!(output.text.contains("target/visible.rs:2:needle 42"));
    // ignore's selected file types override the hidden-file filter, as in the legacy tool.
    assert!(output.text.contains(".hidden.rs:2:needle 42"));
    for excluded in ["b.tsx", "ignored.rs", "local.rs"] {
        assert!(!output.text.contains(excluded), "{}", output.text);
    }
    let output = tools
        .execute("Grep", r#"{"pattern":"needle","include":"*.{rs,tsx}"}"#)
        .unwrap();
    assert!(output.text.starts_with("5 match(es):"), "{}", output.text);
    let output = tools
        .execute(
            "Grep",
            r#"{"pattern":"needle","path":"ignored.rs","include":"*.py"}"#,
        )
        .unwrap();
    assert!(output.text.contains("ignored.rs:2:needle 42"));
}

#[test]
fn searches_validate_parameters_and_keep_legacy_no_match_and_io_error_results() {
    let root = tempfile::tempdir().unwrap();
    let mut tools = FileTools::new(root.path().into(), vec![], &[]);
    for name in ["Glob", "Grep"] {
        for arguments in [
            r#"{}"#,
            r#"{"pattern":3}"#,
            r#"{"pattern":"x","path":4}"#,
            r#"{"pattern":"x","extra":true}"#,
            r#"{"pattern":"x","path":""}"#,
        ] {
            assert!(
                tools.execute(name, arguments).is_err(),
                "{name}: {arguments}"
            );
        }
        for arguments in [r#"{"pattern":"x"}"#, r#"{"pattern":"x","path":"missing"}"#] {
            let output = tools.execute(name, arguments).unwrap();
            assert!(output.text.starts_with("No "));
        }
    }
    assert!(tools.execute("Glob", r#"{"pattern":"["}"#).is_err());
    assert!(tools.execute("Grep", r#"{"pattern":"("}"#).is_err());
    assert!(
        tools
            .execute("Grep", r#"{"pattern":"x","include":"["}"#)
            .is_err()
    );
    fixture(root.path(), "binary", "prefix");
    fs::write(root.path().join("binary"), [0xff, 0xfe, 0xff]).unwrap();
    assert!(
        tools
            .execute("Grep", r#"{"pattern":"x"}"#)
            .unwrap()
            .text
            .starts_with("No matches")
    );
    assert!(tools.execute("RequestPermission", "{}").is_err());
}

#[test]
fn search_output_limits_bound_many_matches_and_one_long_unicode_line() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path(), "many", &"needle\n".repeat(6000));
    fixture(root.path(), "unicode", &"中".repeat(100_000));
    let mut tools = FileTools::new(root.path().into(), vec![], &[]);
    for arguments in [
        r#"{"pattern":"needle","path":"many"}"#,
        r#"{"pattern":"中","path":"unicode"}"#,
    ] {
        let output = tools.execute("Grep", arguments).unwrap();
        assert!(output.text.len() <= 64 * 1024);
        assert!(output.text.contains("truncated"));
        let metadata: serde_json::Value =
            serde_json::from_str(&output.metadata_json.unwrap()).unwrap();
        assert_eq!(metadata["search"]["truncated"], true);
        assert!(metadata["search"]["shown"].as_u64().unwrap() <= 5000);
    }
    let long = "x".repeat(180);
    for index in 0..500 {
        fixture(root.path(), &format!("{long}-{index:03}.txt"), "x");
    }
    let output = tools.execute("Glob", r#"{"pattern":"*.txt"}"#).unwrap();
    assert!(output.text.len() <= 64 * 1024);
    assert!(output.text.contains("truncated"));
}

#[test]
fn searches_observe_pre_cancelled_tokens_without_mutating_files() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path(), "file", "unchanged\n");
    let mut tools = FileTools::new(root.path().into(), vec![], &[]);
    let token = CancellationToken::new();
    token.cancel();
    for name in ["Glob", "Grep"] {
        assert_eq!(
            tools
                .execute_cancellable(name, r#"{"pattern":"*"}"#, &token)
                .unwrap_err(),
            "Cancelled"
        );
    }
    assert_eq!(
        fs::read_to_string(root.path().join("file")).unwrap(),
        "unchanged\n"
    );
}

#[cfg(unix)]
#[test]
fn search_reads_outside_cwd_but_does_not_descend_symlink_directories() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir_in(dirs::home_dir().unwrap()).unwrap();
    fixture(outside.path(), "readable.txt", "needle\n");
    std::os::unix::fs::symlink(outside.path(), root.path().join("linked-dir")).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("readable.txt"),
        root.path().join("linked-file.txt"),
    )
    .unwrap();
    let mut tools = FileTools::new(root.path().into(), vec![], &[]);
    let output = tools.execute("Glob", r#"{"pattern":"*.txt"}"#).unwrap();
    assert!(output.text.contains("linked-file.txt"));
    assert!(!output.text.contains("linked-dir/"));
    let args = json!({"pattern":"needle", "path":outside.path()}).to_string();
    let output = tools.execute("Grep", &args).unwrap();
    assert!(output.text.contains("readable.txt:1:needle"));
    assert_eq!(
        fs::read_to_string(outside.path().join("readable.txt")).unwrap(),
        "needle\n"
    );
}
