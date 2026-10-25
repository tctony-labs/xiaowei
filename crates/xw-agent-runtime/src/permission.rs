use std::path::{Component, Path, PathBuf};

use xw_agent_types::PermissionTarget;

/// Resolve existing ancestors too: a missing leaf must not bypass a symlink check.
pub(crate) fn resolve(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("文件路径必须为绝对路径".into());
    }
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::CurDir => {}
            _ => {
                resolved.push(component);
                match resolved.symlink_metadata() {
                    Ok(_) => resolved = resolved.canonicalize().map_err(|e| e.to_string())?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
        }
    }
    Ok(resolved)
}

pub(crate) fn check_write(
    cwd: &Path,
    path: &Path,
    grants: &[PermissionTarget],
) -> Result<PathBuf, String> {
    let target = resolve(path)?;
    let allowed = writable_paths(cwd, grants)?
        .iter()
        .any(|(path, directory)| {
            if *directory {
                target.starts_with(path)
            } else {
                target == *path
            }
        });
    if allowed {
        Ok(target)
    } else {
        Err("权限不足：目标路径不在当前可写范围内，操作未执行".into())
    }
}

/// One shared set of resolved write targets for file tools and the shell sandbox.
pub(crate) fn writable_paths(
    cwd: &Path,
    grants: &[PermissionTarget],
) -> Result<Vec<(PathBuf, bool)>, String> {
    let cwd = resolve(cwd)?;
    let home = dirs::home_dir().and_then(|p| resolve(&p).ok());
    let broad = home.as_ref().is_some_and(|home| home.starts_with(&cwd));
    let mut paths: Vec<_> = [PathBuf::from("/tmp"), PathBuf::from("/private/tmp")]
        .into_iter()
        .chain(home.as_ref().map(|home| home.join("tmp")))
        .filter_map(|path| resolve(&path).ok().map(|path| (path, true)))
        .collect();
    if !broad {
        paths.push((cwd, true));
    }
    paths.extend(grants.iter().filter_map(|grant| {
        resolve(Path::new(&grant.path))
            .ok()
            .map(|path| (path, grant.is_directory))
    }));
    Ok(paths)
}
