#![cfg(target_os = "macos")]

use serde_json::json;
use std::{path::Path, time::Duration};
use xw_agent_runtime::{CancellationToken, tools::bash};
use xw_agent_types::PermissionMode;

fn arguments(command: &str) -> String {
    json!({"description": "验收命令", "command": command}).to_string()
}

#[tokio::test]
async fn sandbox_setup_failure_never_suggests_requesting_path_access() {
    let cwd = tempfile::tempdir().unwrap();
    let command = "printf 'sandbox-exec: sandbox_apply: Operation not permitted\n' >&2; exit 1";
    let result = bash::execute(
        cwd.path(),
        PermissionMode::Interactive,
        &[],
        &arguments(command),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(result.is_error);
    assert!(result.output.text.contains("Bash 沙箱启动失败"));
    assert!(!result.output.text.contains("RequestPermission"));
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
        PermissionMode::FullAccess,
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
            "head -c 100000 /dev/zero & head -c 100000 /dev/zero >&2; wait",
            100000,
            100000,
        ),
        ("printf '中%.0s' {1..12000}", 36000, 0),
    ] {
        let output = bash::execute(
            root.path(),
            PermissionMode::FullAccess,
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
        assert!(output.output.text.chars().count() < 7_700);
    }

    let output = bash::execute(
        root.path(),
        PermissionMode::FullAccess,
        &[],
        &arguments("printf '甲%.0s' {1..4000}; printf '乙%.0s' {1..4000} >&2"),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let (_, stdout_and_stderr) = output.output.text.split_once('\n').unwrap();
    assert_eq!(stdout_and_stderr.matches('甲').count(), 8192 / 3);
    assert_eq!(stdout_and_stderr.matches('乙').count(), 8192 / 3);
    assert!(stdout_and_stderr.contains("output truncated at capture limit"));
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
                PermissionMode::FullAccess,
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
        bash::execute(
            root.path(),
            PermissionMode::FullAccess,
            &[],
            &arguments("touch unexpected"),
            cancelled
        )
        .await
        .is_err()
    );
    assert!(!root.path().join("unexpected").exists());
}

#[tokio::test]
async fn full_access_writes_outside_cwd_without_a_grant() {
    let cwd = tempfile::tempdir().unwrap();
    let home = dirs::home_dir().unwrap();
    let outside = tempfile::tempdir_in(&home).unwrap();
    let target = outside.path().join("output.txt");
    let path = target.to_str().unwrap().replace('\'', "'\\''");
    let command = format!("printf outside > '{path}'");

    let result = bash::execute(
        cwd.path(),
        PermissionMode::FullAccess,
        &[],
        &arguments(&command),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(!result.is_error, "{}", result.output.text);
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "outside");
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
        let task = tokio::spawn(async move {
            bash::execute(&cwd, PermissionMode::FullAccess, &[], &args, worker_token).await
        });
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
        PermissionMode::FullAccess,
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
