use xw_agent_runtime::tools::FileTools;

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
