#![cfg(target_os = "macos")]

use serde_json::json;
use std::{path::Path, time::Duration};
use xw_agent_runtime::{CancellationToken, tools::bash};
use xw_agent_types::PermissionTarget;

fn arguments(command: &str) -> String {
    json!({"description": "验收命令", "command": command}).to_string()
}

async fn wait_file(path: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn foreground_output_exit_and_bounded_capture() {
    let root = tempfile::tempdir().unwrap();
    let result = bash::execute(
        root.path(),
        &[],
        &arguments("printf hello; printf error >&2; exit 7"),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(!result.is_error);
    assert!(result.output.text.contains("hello\nerror"));
    let metadata: serde_json::Value =
        serde_json::from_str(&result.output.metadata_json.unwrap()).unwrap();
    assert_eq!(metadata["bash"]["exit_code"], 7);
    for (command, stdout, stderr) in [
        ("printf '%40000s' x", 40000, 0),
        (
            "(printf '%100000s' x) & printf '%100000s' y >&2; wait",
            100000,
            100000,
        ),
        ("printf '中%.0s' {1..12000}", 36000, 0),
    ] {
        let output = bash::execute(
            root.path(),
            &[],
            &arguments(command),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let metadata: serde_json::Value =
            serde_json::from_str(&output.output.metadata_json.unwrap()).unwrap();
        assert_eq!(metadata["bash"]["stdout_bytes"], stdout);
        assert_eq!(metadata["bash"]["stderr_bytes"], stderr);
        assert_eq!(metadata["bash"]["truncated"], true);
        assert!(output.output.text.contains("truncated"));
        assert!(output.output.text.chars().count() < 31000);
    }
}

#[tokio::test]
async fn invalid_and_background_parameters_never_execute() {
    let root = tempfile::tempdir().unwrap();
    for args in [
        json!({"command":"touch unexpected"}),
        json!({"description":"test","command":"touch unexpected","is_background":true}),
        json!({"description":"test","command":"sudo touch unexpected"}),
        json!({"description":"test","command":"touch unexpected","timeout_ms":-1}),
    ] {
        assert!(
            bash::execute(
                root.path(),
                &[],
                &args.to_string(),
                CancellationToken::new()
            )
            .await
            .is_err()
        );
    }
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(
        bash::execute(root.path(), &[], &arguments("touch unexpected"), cancelled)
            .await
            .is_err()
    );
    assert!(!root.path().join("unexpected").exists());
}

#[tokio::test]
async fn home_boundary_and_file_grant_are_not_expanded() {
    let home = dirs::home_dir().unwrap();
    let outside = tempfile::tempdir_in(&home).unwrap();
    let target = outside.path().join("allowed");
    std::fs::write(&target, "old").unwrap();
    let command = format!("printf allowed > '{}'", target.display());
    let denied = bash::execute(&home, &[], &arguments(&command), CancellationToken::new())
        .await
        .unwrap();
    assert!(denied.is_error, "{}", denied.output.text);
    let grants = vec![PermissionTarget {
        path: target.to_str().unwrap().into(),
        is_directory: false,
    }];
    let allowed = bash::execute(
        &home,
        &grants,
        &arguments(&command),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(!allowed.is_error, "{}", allowed.output.text);
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "allowed");
    let sibling = outside.path().join("not-allowed");
    let command = format!("printf denied > '{}'", sibling.display());
    assert!(
        bash::execute(
            &home,
            &grants,
            &arguments(&command),
            CancellationToken::new()
        )
        .await
        .unwrap()
        .is_error
    );
    assert!(!sibling.exists());
}

#[tokio::test]
async fn cancellation_and_timeout_reap_the_child_group_and_preserve_partial_output() {
    for cancel in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let token = CancellationToken::new();
        let worker_token = token.clone();
        let cwd = root.path().to_path_buf();
        let args = json!({"description":"test", "timeout_ms":if cancel {30000} else {300},
            "command":"printf partial; /bin/sleep 30 & echo $! > child.pid; wait"})
        .to_string();
        let task = tokio::spawn(async move { bash::execute(&cwd, &[], &args, worker_token).await });
        wait_file(&root.path().join("child.pid")).await;
        let pid: i32 = std::fs::read_to_string(root.path().join("child.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        if cancel {
            token.cancel();
        }
        let output = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(output.is_error);
        assert_eq!(output.cancelled, cancel);
        assert!(output.output.text.contains("partial"));
        assert!(
            unsafe { libc::kill(pid, 0) } != 0,
            "child remained alive: {pid}"
        );
    }
}

#[tokio::test]
async fn successful_shell_does_not_leave_background_children() {
    let root = tempfile::tempdir().unwrap();
    let output = bash::execute(
        root.path(),
        &[],
        &arguments("/bin/sleep 30 & echo $! > child.pid"),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(!output.is_error);
    let pid: i32 = std::fs::read_to_string(root.path().join("child.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(unsafe { libc::kill(pid, 0) } != 0);
}
