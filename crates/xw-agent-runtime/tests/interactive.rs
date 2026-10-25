use xw_agent_runtime::tools::interactive::{parse, result, validate_answer};
use xw_agent_types::{InteractionAnswer, InteractionRequest};

#[test]
fn questions_preserve_indices_and_support_text_without_choices() {
    let request = parse(
        "AskUserQuestion",
        r#"{"question":"选择？","options":["同名","同名"]}"#,
    )
    .unwrap();
    let answer = InteractionAnswer::Question {
        selected_indices: vec![1],
        text: Some("补充".into()),
    };
    assert_eq!(
        result(&request, &answer).unwrap().text,
        "用户回答：\n同名\n补充"
    );
    for selected_indices in [vec![2], vec![0, 1], vec![0, 0], vec![]] {
        assert!(
            validate_answer(
                &request,
                &InteractionAnswer::Question {
                    selected_indices,
                    text: None,
                }
            )
            .is_err()
        );
    }
    let request = parse("AskUserQuestion", r#"{"question":"请说明"}"#).unwrap();
    assert!(
        validate_answer(
            &request,
            &InteractionAnswer::Question {
                selected_indices: vec![],
                text: Some("文字回答".into()),
            }
        )
        .is_ok()
    );
    assert!(parse("AskUserQuestion", r#"{"question":" "}"#).is_err());
    assert!(parse("AskUserQuestion", r#"{"question":"q","unexpected":true}"#).is_err());
    let args = serde_json::json!({"question":"q", "options": vec!["a"; 13]});
    assert!(parse("AskUserQuestion", &args.to_string()).is_err());
}

#[test]
fn permission_targets_resolve_symlinks_and_reject_scope_and_answer_mismatches() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("file");
    std::fs::write(&file, "original").unwrap();
    let arguments = |path: &std::path::Path, directory| {
        serde_json::json!({
            "path": path, "is_directory": directory, "reason": "测试",
        })
        .to_string()
    };
    assert!(parse("RequestPermission", &arguments(&file, true)).is_err());
    assert!(parse("RequestPermission", &arguments(root.path(), false)).is_err());
    assert!(
        parse(
            "RequestPermission",
            &arguments(std::path::Path::new("relative"), false)
        )
        .is_err()
    );
    let request = parse("RequestPermission", &arguments(&file, false)).unwrap();
    assert!(
        validate_answer(
            &request,
            &InteractionAnswer::Question {
                selected_indices: vec![],
                text: Some("同意".into()),
            }
        )
        .is_err()
    );
    assert!(
        result(&request, &InteractionAnswer::Permission { allow: false })
            .unwrap()
            .text
            .contains("拒绝")
    );
    #[cfg(unix)]
    {
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let request = parse("RequestPermission", &arguments(&link, false)).unwrap();
        let InteractionRequest::Permission { target, .. } = request else {
            panic!();
        };
        assert_eq!(target.path, file.canonicalize().unwrap().to_string_lossy());
    }
}
