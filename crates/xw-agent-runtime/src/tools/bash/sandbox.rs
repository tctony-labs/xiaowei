use std::path::Path;

use xw_agent_types::PermissionTarget;

#[cfg(target_os = "macos")]
pub(super) fn command(
    cwd: &Path,
    grants: &[PermissionTarget],
    script: &str,
) -> Result<tokio::process::Command, String> {
    use xw_sandboxed_exec::{SandboxPolicy, WritableRoot, seatbelt};

    let roots = crate::permission::writable_paths(cwd, grants)?
        .into_iter()
        .map(|(path, directory)| {
            if directory {
                WritableRoot::unprotected(path)
            } else {
                WritableRoot::file(path)
            }
        })
        .collect();
    let mut policy = SandboxPolicy::workspace_write(roots, true);
    // The shared permission rules already account for home and its ancestors.
    policy.auto_add_cwd = false;
    let args = seatbelt::create_seatbelt_command_args("/bin/bash", &["-c", script], &policy, cwd);
    let mut command = tokio::process::Command::new(seatbelt::SANDBOX_EXEC_PATH);
    command.args(args);
    Ok(command)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn command(
    _: &Path,
    _: &[PermissionTarget],
    _: &str,
) -> Result<tokio::process::Command, String> {
    Err("当前平台不支持 Bash 沙箱，命令未执行".into())
}
