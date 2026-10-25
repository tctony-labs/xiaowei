//! Sandbox policy definitions
//!
//! This module defines the cross-platform sandbox policy types that control
//! file system access and network access for sandboxed processes.
//!
//! File access and network access are two orthogonal dimensions, allowing
//! any combination of restrictions.

use std::fs;
use std::path::PathBuf;

/// File system access policy.
///
/// All policies allow full disk read access (required by compilers, toolchains, etc.)
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum FileAccess {
    /// Full disk read access, no write access allowed.
    #[default]
    ReadOnly,

    /// Full disk read access, write access to specified directories only.
    /// This is the most common mode for development tools.
    WorkspaceWrite {
        /// Directories that can be written to.
        writable_roots: Vec<WritableRoot>,
    },

    /// Full access with no file system restrictions (dangerous).
    FullAccess,
}

impl FileAccess {
    /// Returns true if this policy allows full disk read access.
    /// Currently always returns true as restricting read access is not supported.
    pub fn has_full_disk_read_access(&self) -> bool {
        true
    }

    /// Returns true if this policy allows full disk write access.
    pub fn has_full_disk_write_access(&self) -> bool {
        matches!(self, FileAccess::FullAccess)
    }

    /// Returns the writable roots for this policy.
    /// Returns an empty slice for ReadOnly and FullAccess policies.
    pub fn writable_roots(&self) -> &[WritableRoot] {
        match self {
            FileAccess::WorkspaceWrite { writable_roots } => writable_roots,
            _ => &[],
        }
    }
}

/// Sandbox policy defining access control rules.
///
/// Combines file access and network access as two orthogonal dimensions,
/// allowing any combination of restrictions.
#[derive(Debug, Clone)]
pub struct SandboxPolicy {
    /// File system access policy.
    pub file_access: FileAccess,
    /// Whether network access is allowed.
    pub network_access: bool,
    /// Whether to automatically add cwd as a writable root in WorkspaceWrite mode.
    /// Default: true. Set to false when cwd is too broad (e.g. $HOME).
    pub auto_add_cwd: bool,
}

impl Default for SandboxPolicy {
    fn default() -> Self {
        SandboxPolicy {
            file_access: FileAccess::ReadOnly,
            network_access: false,
            auto_add_cwd: true,
        }
    }
}

impl SandboxPolicy {
    /// Create a new sandbox policy with the given file access and network access.
    pub fn new(file_access: FileAccess, network_access: bool) -> Self {
        Self {
            file_access,
            network_access,
            auto_add_cwd: true,
        }
    }

    /// Create a read-only policy (no write, no network).
    pub fn read_only() -> Self {
        Self {
            file_access: FileAccess::ReadOnly,
            network_access: false,
            auto_add_cwd: true,
        }
    }

    /// Create a workspace-write policy with the given writable roots.
    pub fn workspace_write(writable_roots: Vec<WritableRoot>, network_access: bool) -> Self {
        Self {
            file_access: FileAccess::WorkspaceWrite { writable_roots },
            network_access,
            auto_add_cwd: true,
        }
    }

    /// Create a full access policy (dangerous, use for debugging only).
    pub fn full_access() -> Self {
        Self {
            file_access: FileAccess::FullAccess,
            network_access: true,
            auto_add_cwd: true,
        }
    }

    /// Returns true if this policy allows full disk read access.
    pub fn has_full_disk_read_access(&self) -> bool {
        self.file_access.has_full_disk_read_access()
    }

    /// Returns true if this policy allows full disk write access.
    pub fn has_full_disk_write_access(&self) -> bool {
        self.file_access.has_full_disk_write_access()
    }

    /// Returns true if this policy allows network access.
    pub fn has_network_access(&self) -> bool {
        self.network_access
    }

    /// Returns the writable roots for this policy.
    pub fn writable_roots(&self) -> &[WritableRoot] {
        self.file_access.writable_roots()
    }
}

/// A writable root directory with optional protected subpaths.
///
/// Protected paths within the writable root will remain read-only,
/// preventing modification of sensitive files like `.git` or `.codex`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WritableRoot {
    /// The root directory that can be written to.
    pub root: PathBuf,
    /// False grants only this exact file, never its descendants.
    pub is_directory: bool,
    /// Subpaths within the root that should remain read-only.
    pub protected_paths: Vec<PathBuf>,
}

impl WritableRoot {
    /// Create a new writable root with explicit protected paths.
    pub fn new(root: PathBuf, protected_paths: Vec<PathBuf>) -> Self {
        Self {
            root,
            is_directory: true,
            protected_paths,
        }
    }

    /// Create a new writable root from a path, automatically detecting
    /// and protecting `.git` and `.codex` directories.
    pub fn with_auto_protection(root: PathBuf) -> Self {
        let mut protected = Vec::new();

        // Detect .git (directory or worktree pointer file)
        let git_path = root.join(".git");
        if git_path.exists() {
            // If .git is a file (worktree), also protect the actual gitdir
            if git_path.is_file()
                && let Ok(contents) = fs::read_to_string(&git_path)
                && let Some(gitdir) = parse_gitdir_pointer(&contents)
            {
                protected.push(gitdir);
            }
            protected.push(git_path);
        }

        // Detect .codex
        let codex_path = root.join(".codex");
        if codex_path.exists() {
            protected.push(codex_path);
        }

        Self {
            root,
            is_directory: true,
            protected_paths: protected,
        }
    }

    /// Grant one exact path without granting the containing directory.
    pub fn file(root: PathBuf) -> Self {
        Self {
            root,
            is_directory: false,
            protected_paths: Vec::new(),
        }
    }

    /// Create a writable root with no protected paths.
    pub fn unprotected(root: PathBuf) -> Self {
        Self {
            root,
            is_directory: true,
            protected_paths: Vec::new(),
        }
    }
}

/// Parse a git worktree pointer file to extract the gitdir path.
///
/// Git worktree `.git` files contain a line like: `gitdir: /path/to/actual/gitdir`
fn parse_gitdir_pointer(contents: &str) -> Option<PathBuf> {
    for line in contents.lines() {
        let line = line.trim();
        if let Some(path) = line.strip_prefix("gitdir:") {
            let path = path.trim();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sandbox_policy_default() {
        let policy = SandboxPolicy::default();
        assert!(policy.has_full_disk_read_access());
        assert!(!policy.has_full_disk_write_access());
        assert!(!policy.has_network_access());
        assert_eq!(policy.file_access, FileAccess::ReadOnly);
    }

    #[test]
    fn test_sandbox_policy_read_only() {
        let policy = SandboxPolicy::read_only();
        assert!(!policy.has_network_access());
        assert_eq!(policy.file_access, FileAccess::ReadOnly);
    }

    #[test]
    fn test_sandbox_policy_read_only_with_network() {
        let policy = SandboxPolicy::new(FileAccess::ReadOnly, true);
        assert!(policy.has_network_access());
        assert!(!policy.has_full_disk_write_access());
    }

    #[test]
    fn test_sandbox_policy_workspace_write() {
        let policy = SandboxPolicy::workspace_write(
            vec![WritableRoot::unprotected(PathBuf::from("/tmp"))],
            true,
        );
        assert!(policy.has_full_disk_read_access());
        assert!(!policy.has_full_disk_write_access());
        assert!(policy.has_network_access());
        assert_eq!(policy.writable_roots().len(), 1);
    }

    #[test]
    fn test_sandbox_policy_full_access() {
        let policy = SandboxPolicy::full_access();
        assert!(policy.has_full_disk_read_access());
        assert!(policy.has_full_disk_write_access());
        assert!(policy.has_network_access());
    }

    #[test]
    fn test_file_access_read_only() {
        let access = FileAccess::ReadOnly;
        assert!(access.has_full_disk_read_access());
        assert!(!access.has_full_disk_write_access());
        assert!(access.writable_roots().is_empty());
    }

    #[test]
    fn test_file_access_workspace_write() {
        let access = FileAccess::WorkspaceWrite {
            writable_roots: vec![WritableRoot::unprotected(PathBuf::from("/tmp"))],
        };
        assert!(access.has_full_disk_read_access());
        assert!(!access.has_full_disk_write_access());
        assert_eq!(access.writable_roots().len(), 1);
    }

    #[test]
    fn test_file_access_full_access() {
        let access = FileAccess::FullAccess;
        assert!(access.has_full_disk_read_access());
        assert!(access.has_full_disk_write_access());
    }

    #[test]
    fn test_writable_root_new() {
        let root = WritableRoot::new(
            PathBuf::from("/project"),
            vec![PathBuf::from("/project/.git")],
        );
        assert_eq!(root.root, PathBuf::from("/project"));
        assert_eq!(root.protected_paths.len(), 1);
    }

    #[test]
    fn test_parse_gitdir_pointer() {
        let contents = "gitdir: /path/to/actual/gitdir\n";
        assert_eq!(
            parse_gitdir_pointer(contents),
            Some(PathBuf::from("/path/to/actual/gitdir"))
        );

        let contents = "  gitdir:   /another/path  \n";
        assert_eq!(
            parse_gitdir_pointer(contents),
            Some(PathBuf::from("/another/path"))
        );

        let contents = "not a gitdir file";
        assert_eq!(parse_gitdir_pointer(contents), None);
    }
}
