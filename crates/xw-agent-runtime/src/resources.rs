use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::SystemTime,
};

use crate::tools::command::{self, CommandBody, CommandSnapshot};

#[derive(Clone, Copy, Debug)]
pub enum ResourceScope {
    User,
    Project,
}

impl ResourceScope {
    pub fn name(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Project => "project",
        }
    }
}

#[derive(Debug)]
pub struct ResourceFile {
    pub path: PathBuf,
    pub text: String,
    pub hash: String,
    pub(crate) command: OnceLock<Result<Arc<CommandBody>, &'static str>>,
}

#[derive(Clone, Debug)]
pub struct RuleFile {
    pub key: String,
    pub file: Arc<ResourceFile>,
}

#[derive(Default)]
pub struct ResourceSnapshot {
    pub rules: Vec<RuleFile>,
    pub commands: CommandSnapshot,
}

struct CachedFile {
    modified: SystemTime,
    size: u64,
    file: Arc<ResourceFile>,
}

/// Only caches files; committed system context and tool outcomes remain authoritative.
#[derive(Default)]
pub struct ResourceCache {
    files: BTreeMap<PathBuf, CachedFile>,
    seen: BTreeSet<PathBuf>,
    #[cfg(test)]
    reads: usize,
}

impl ResourceCache {
    pub fn snapshot(&mut self, user_root: Option<&Path>, cwd: Option<&Path>) -> ResourceSnapshot {
        self.seen.clear();
        let mut snapshot = ResourceSnapshot::default();
        if let Some(root) = user_root {
            self.scan(root, root, ResourceScope::User, &mut snapshot);
        }
        if let Some(cwd) = cwd {
            self.scan(
                cwd,
                &cwd.join(".xiaowei"),
                ResourceScope::Project,
                &mut snapshot,
            );
        }
        self.files.retain(|path, _| self.seen.contains(path));
        snapshot
    }

    fn scan(
        &mut self,
        top: &Path,
        scoped: &Path,
        scope: ResourceScope,
        snapshot: &mut ResourceSnapshot,
    ) {
        let mut visited = BTreeSet::new();
        self.rule(
            top.join("AGENTS.md"),
            "AGENTS.md",
            scope,
            true,
            &mut visited,
            snapshot,
        );
        for path in markdown_files(&scoped.join("rules")) {
            let relative = format!("rules/{}", path.file_name().unwrap().to_string_lossy());
            self.rule(path, &relative, scope, false, &mut visited, snapshot);
        }
        command::scan(
            self,
            &scoped.join("commands"),
            scope,
            &mut snapshot.commands,
        );
    }

    fn rule(
        &mut self,
        mut path: PathBuf,
        relative: &str,
        scope: ResourceScope,
        redirects: bool,
        visited: &mut BTreeSet<PathBuf>,
        snapshot: &mut ResourceSnapshot,
    ) {
        loop {
            let Some(file) = self.read(&path) else {
                return;
            };
            if !visited.insert(file.path.clone()) {
                if redirects {
                    log::warn!(
                        "Agent rule skipped path={} reason=redirect_cycle",
                        path.display()
                    );
                }
                return;
            }
            if redirects
                && let Some(target) = file.text.trim().strip_prefix('@')
                && !target.is_empty()
                && !target.contains(char::is_whitespace)
            {
                path = path.parent().unwrap_or(Path::new(".")).join(target);
                continue;
            }
            if !file.text.trim().is_empty() {
                snapshot.rules.push(RuleFile {
                    key: format!("rules.{}.{relative}", scope.name()),
                    file,
                });
            }
            return;
        }
    }

    pub(crate) fn invalidate(&mut self, path: &Path) {
        self.files.remove(path);
    }

    pub(crate) fn read(&mut self, path: &Path) -> Option<Arc<ResourceFile>> {
        let result = (|| {
            let canonical = fs::canonicalize(path)?;
            self.seen.insert(canonical.clone());
            let metadata = fs::metadata(&canonical)?;
            let modified = metadata.modified()?;
            if let Some(cached) = self.files.get(&canonical)
                && cached.modified == modified
                && cached.size == metadata.len()
            {
                return Ok(cached.file.clone());
            }
            #[cfg(test)]
            {
                self.reads += 1;
            }
            let text = fs::read_to_string(&canonical)?;
            let file = Arc::new(ResourceFile {
                path: canonical.clone(),
                hash: blake3::hash(text.as_bytes()).to_hex().to_string(),
                text,
                command: OnceLock::new(),
            });
            self.files.insert(
                canonical,
                CachedFile {
                    modified,
                    size: metadata.len(),
                    file: file.clone(),
                },
            );
            Ok::<_, std::io::Error>(file)
        })();
        match result {
            Ok(file) => Some(file),
            Err(error) => {
                if let Ok(canonical) = fs::canonicalize(path) {
                    self.files.remove(&canonical);
                }
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(
                        "Agent resource read failed path={} kind={:?}",
                        path.display(),
                        error.kind()
                    );
                }
                None
            }
        }
    }
}

pub(crate) fn markdown_files(directory: &Path) -> Vec<PathBuf> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "Agent resource scan failed directory={} kind={:?}",
                    directory.display(),
                    error.kind()
                );
            }
            return Vec::new();
        }
    };
    let mut paths = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => {
                let path = entry.path();
                if path.is_file() && path.extension().is_some_and(|extension| extension == "md") {
                    paths.push(path);
                }
            }
            Err(error) => log::warn!("Agent resource entry failed kind={:?}", error.kind()),
        }
    }
    paths.sort();
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unchanged_files_reuse_bytes_and_parsed_commands_and_deletions_prune_cache() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("commands")).unwrap();
        fs::write(root.path().join("AGENTS.md"), "rule").unwrap();
        fs::write(root.path().join("commands/test.md"), "body").unwrap();
        let mut cache = ResourceCache::default();
        let first = cache.snapshot(Some(root.path()), None);
        let second = cache.snapshot(Some(root.path()), None);
        assert_eq!(cache.reads, 2);
        assert!(Arc::ptr_eq(&first.rules[0].file, &second.rules[0].file));
        assert!(Arc::ptr_eq(
            &first.commands["test"].body,
            &second.commands["test"].body
        ));

        let path = root.path().join("AGENTS.md");
        fs::File::open(&path)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(100)),
            )
            .unwrap();
        let touched = cache.snapshot(Some(root.path()), None);
        assert_eq!(cache.reads, 3);
        assert_eq!(first.rules[0].file.text, touched.rules[0].file.text);

        fs::remove_file(path).unwrap();
        fs::remove_file(root.path().join("commands/test.md")).unwrap();
        let empty = cache.snapshot(Some(root.path()), None);
        assert!(empty.rules.is_empty() && empty.commands.is_empty());
        assert!(cache.files.is_empty());
    }
}
