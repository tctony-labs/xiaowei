//! macOS Seatbelt sandbox implementation
//!
//! This module implements sandbox execution using macOS's `/usr/bin/sandbox-exec`
//! with SBPL (Seatbelt Profile Language) policies.

#![cfg(target_os = "macos")]

use crate::policy::{FileAccess, SandboxPolicy, WritableRoot};
use std::ffi::CStr;
use std::path::{Path, PathBuf};

/// Base SBPL policy template
const SEATBELT_BASE_POLICY: &str = include_str!("seatbelt.sbpl");

/// Network access SBPL policy
const SEATBELT_NETWORK_POLICY: &str = include_str!("seatbelt_network.sbpl");

/// Path to sandbox-exec executable.
/// Hardcoded to prevent PATH injection attacks.
pub const SANDBOX_EXEC_PATH: &str = "/usr/bin/sandbox-exec";

/// Create the command-line arguments for sandbox-exec.
pub fn create_seatbelt_command_args(
    command: &str,
    args: &[&str],
    policy: &SandboxPolicy,
    cwd: &Path,
) -> Vec<String> {
    let (file_write_policy, file_write_params) = generate_file_write_policy(policy, cwd);
    let file_read_policy = generate_file_read_policy(policy);
    let network_policy = generate_network_policy(policy);

    let full_policy = format!(
        "{SEATBELT_BASE_POLICY}\n{file_read_policy}\n{file_write_policy}\n{network_policy}"
    );

    let dir_params = [file_write_params, get_darwin_dir_params()].concat();

    let mut seatbelt_args: Vec<String> = vec!["-p".to_string(), full_policy];

    // Add -D parameters for paths
    for (key, value) in dir_params {
        seatbelt_args.push(format!("-D{}={}", key, value.to_string_lossy()));
    }

    seatbelt_args.push("--".to_string());
    seatbelt_args.push(command.to_string());
    seatbelt_args.extend(args.iter().map(|s| s.to_string()));

    seatbelt_args
}

/// Generate file read policy.
fn generate_file_read_policy(policy: &SandboxPolicy) -> &'static str {
    if policy.has_full_disk_read_access() {
        "; allow read-only file operations\n(allow file-read*)"
    } else {
        ""
    }
}

/// Generate file write policy and path parameters.
fn generate_file_write_policy(
    policy: &SandboxPolicy,
    cwd: &Path,
) -> (String, Vec<(String, PathBuf)>) {
    if policy.has_full_disk_write_access() {
        // Full access: allow writing everywhere
        (
            r#"(allow file-write* (regex #"^/"))"#.to_string(),
            Vec::new(),
        )
    } else {
        let writable_roots = get_writable_roots_with_cwd(policy, cwd);

        if writable_roots.is_empty() {
            return (String::new(), Vec::new());
        }

        let mut policies: Vec<String> = Vec::new();
        let mut params: Vec<(String, PathBuf)> = Vec::new();

        for (index, wr) in writable_roots.iter().enumerate() {
            let canonical_root = wr.root.canonicalize().unwrap_or_else(|_| wr.root.clone());
            let root_param = format!("WRITABLE_ROOT_{index}");
            params.push((root_param.clone(), canonical_root));

            if !wr.is_directory {
                policies.push(format!("(literal (param \"{root_param}\"))"));
            } else if wr.protected_paths.is_empty() {
                policies.push(format!("(subpath (param \"{root_param}\"))"));
            } else {
                // Generate require-not clauses for protected paths
                let mut require_parts: Vec<String> = Vec::new();
                require_parts.push(format!("(subpath (param \"{root_param}\"))"));

                for (subpath_index, protected) in wr.protected_paths.iter().enumerate() {
                    let canonical_protected = protected
                        .canonicalize()
                        .unwrap_or_else(|_| protected.clone());
                    let protected_param = format!("WRITABLE_ROOT_{index}_RO_{subpath_index}");
                    require_parts.push(format!(
                        "(require-not (subpath (param \"{protected_param}\")))"
                    ));
                    params.push((protected_param, canonical_protected));
                }

                policies.push(format!("(require-all {} )", require_parts.join(" ")));
            }
        }

        let file_write_policy = format!("(allow file-write*\n{}\n)", policies.join(" "));
        (file_write_policy, params)
    }
}

/// Generate network access policy.
fn generate_network_policy(policy: &SandboxPolicy) -> &'static str {
    if policy.has_network_access() {
        SEATBELT_NETWORK_POLICY
    } else {
        ""
    }
}

/// Get writable roots based on policy.
/// For ReadOnly: no writable roots
/// For WorkspaceWrite: specified roots + cwd (if not already covered)
fn get_writable_roots_with_cwd(policy: &SandboxPolicy, cwd: &Path) -> Vec<WritableRoot> {
    match &policy.file_access {
        FileAccess::ReadOnly => {
            // ReadOnly means no write access at all
            Vec::new()
        }
        FileAccess::WorkspaceWrite { writable_roots } => {
            let mut roots: Vec<WritableRoot> = writable_roots.clone();

            if policy.auto_add_cwd {
                // Check if cwd is already covered by an existing writable root
                let cwd_canonical = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
                let cwd_covered = roots.iter().any(|wr| {
                    let root_canonical = wr.root.canonicalize().unwrap_or_else(|_| wr.root.clone());
                    cwd_canonical.starts_with(&root_canonical)
                });

                // Add cwd as a writable root with auto-protection only if not already covered
                if !cwd_covered && cwd.exists() {
                    roots.push(WritableRoot::with_auto_protection(cwd.to_path_buf()));
                }
            }

            roots
        }
        FileAccess::FullAccess => {
            // FullAccess doesn't use this function
            Vec::new()
        }
    }
}

/// Get Darwin-specific directory parameters.
fn get_darwin_dir_params() -> Vec<(String, PathBuf)> {
    if let Some(cache_dir) = get_darwin_user_cache_dir() {
        vec![("DARWIN_USER_CACHE_DIR".to_string(), cache_dir)]
    } else {
        vec![]
    }
}

/// Get the Darwin user cache directory using confstr.
fn get_darwin_user_cache_dir() -> Option<PathBuf> {
    confstr_path(libc::_CS_DARWIN_USER_CACHE_DIR)
}

/// Wraps libc::confstr to return a String.
fn confstr(name: libc::c_int) -> Option<String> {
    let mut buf = vec![0_i8; (libc::PATH_MAX as usize) + 1];
    let len = unsafe { libc::confstr(name, buf.as_mut_ptr(), buf.len()) };
    if len == 0 {
        return None;
    }
    let cstr = unsafe { CStr::from_ptr(buf.as_ptr()) };
    cstr.to_str().ok().map(ToString::to_string)
}

/// Wraps confstr to return a canonicalized PathBuf.
fn confstr_path(name: libc::c_int) -> Option<PathBuf> {
    let s = confstr(name)?;
    let path = PathBuf::from(s);
    path.canonicalize().ok().or(Some(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_file_read_policy_readonly() {
        let policy = SandboxPolicy::read_only();
        let result = generate_file_read_policy(&policy);
        assert!(result.contains("(allow file-read*)"));
    }

    #[test]
    fn test_generate_file_read_policy_workspace_write() {
        let policy = SandboxPolicy::workspace_write(vec![], false);
        let result = generate_file_read_policy(&policy);
        assert!(result.contains("(allow file-read*)"));
    }

    #[test]
    fn test_generate_network_policy_disabled() {
        let policy = SandboxPolicy::read_only();
        let result = generate_network_policy(&policy);
        assert!(result.is_empty());
    }

    #[test]
    fn test_generate_network_policy_enabled() {
        let policy = SandboxPolicy::new(FileAccess::ReadOnly, true);
        let result = generate_network_policy(&policy);
        assert!(result.contains("(allow network*)"));
    }

    #[test]
    fn test_create_seatbelt_command_args() {
        let policy = SandboxPolicy::read_only();
        let cwd = PathBuf::from("/tmp");
        let args = create_seatbelt_command_args("echo", &["hello"], &policy, &cwd);

        assert_eq!(args[0], "-p");
        assert!(args.contains(&"--".to_string()));
        assert!(args.contains(&"echo".to_string()));
        assert!(args.contains(&"hello".to_string()));
    }
}
