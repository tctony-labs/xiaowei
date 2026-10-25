#![cfg(target_os = "macos")]

use std::{path::Path, process::Command};
use xw_sandboxed_exec::{SandboxPolicy, WritableRoot, seatbelt};

fn run(cwd: &Path, roots: Vec<WritableRoot>, command: &str) -> std::process::Output {
    let mut policy = SandboxPolicy::workspace_write(roots, false);
    policy.auto_add_cwd = false;
    Command::new(seatbelt::SANDBOX_EXEC_PATH)
        .args(seatbelt::create_seatbelt_command_args(
            "/bin/bash",
            &["-c", command],
            &policy,
            cwd,
        ))
        .current_dir(cwd)
        .output()
        .unwrap()
}

#[test]
fn kernel_enforces_directory_and_exact_file_grants_in_descendants() {
    let root = tempfile::tempdir().unwrap();
    let allowed = root.path().join("allowed");
    let denied = root.path().join("denied");
    std::fs::create_dir(&allowed).unwrap();
    std::fs::create_dir(&denied).unwrap();
    let file = denied.join("one");
    std::fs::write(&file, "old").unwrap();
    let roots = vec![
        WritableRoot::unprotected(allowed.clone()),
        WritableRoot::file(file.clone()),
    ];
    let output = run(
        root.path(),
        roots.clone(),
        "/bin/sh -c 'printf allowed > allowed/new'; printf exact > denied/one",
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(std::fs::read_to_string(file).unwrap(), "exact");
    let output = run(root.path(), roots, "printf denied > denied/two");
    assert!(!output.status.success());
    assert!(!denied.join("two").exists());
}

#[test]
fn symlink_cannot_escape_the_writable_directory() {
    let root = tempfile::tempdir().unwrap();
    let allowed = root.path().join("allowed");
    let denied = root.path().join("denied");
    std::fs::create_dir(&allowed).unwrap();
    std::fs::create_dir(&denied).unwrap();
    std::os::unix::fs::symlink(&denied, allowed.join("escape")).unwrap();
    let output = run(
        root.path(),
        vec![WritableRoot::unprotected(allowed)],
        "printf denied > allowed/escape/new",
    );
    assert!(!output.status.success());
    assert!(!denied.join("new").exists());
}
