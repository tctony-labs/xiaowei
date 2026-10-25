#![cfg(unix)]

use std::process::Command;

const BINARY: &str = env!("CARGO_BIN_EXE_xiaowei-inspect");

#[test]
fn help_and_version_work_without_a_running_app_or_workspace() {
    for option in ["--help", "--version"] {
        let output = Command::new(BINARY)
            .args(["--workspace", "/missing/inspect-workspace", option])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("xiaowei-inspect"));
    }
}

#[test]
fn invalid_commands_fail_before_connecting() {
    for args in [
        vec!["show"],
        vec!["show", "invalid"],
        vec!["status", "extra"],
        vec!["rpc"],
    ] {
        let output = Command::new(BINARY)
            .args(["--json"])
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["error"]["code"], "USAGE");
    }
}

#[test]
fn missing_app_is_reported_without_launching_or_writing_workspace_data() {
    let directory = tempfile::tempdir().unwrap();
    let output = Command::new(BINARY)
        .args(["--json", "--workspace"])
        .arg(directory.path())
        .arg("status")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["error"]["code"], "APP_NOT_RUNNING");
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}
