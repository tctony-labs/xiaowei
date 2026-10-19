use std::path::{Path, PathBuf};

use xw_agent_types::SessionId;

use crate::AgentError;

pub(crate) fn explicit(cwd: Option<&str>) -> Result<Option<String>, AgentError> {
    cwd.map(|cwd| {
        let path = Path::new(cwd);
        if !path.is_absolute() || !path.is_dir() {
            return Err(AgentError::InvalidArgument("cwd"));
        }
        let path = path.canonicalize().map_err(|_| AgentError::Persistence)?;
        path.to_str()
            .map(str::to_owned)
            .ok_or(AgentError::InvalidArgument("cwd"))
    })
    .transpose()
}

pub(crate) fn prepare(root: &Path, id: SessionId) -> Result<String, AgentError> {
    let parent = root.join("quick-chat");
    std::fs::create_dir_all(root).map_err(|_| AgentError::Persistence)?;
    reject_symlink(&parent)?;
    std::fs::create_dir_all(&parent).map_err(|_| AgentError::Persistence)?;
    let path = parent.join(id.to_string());
    reject_symlink(&path)?;
    std::fs::create_dir_all(&path).map_err(|_| AgentError::Persistence)?;
    explicit(path.to_str())?.ok_or(AgentError::Persistence)
}

fn reject_symlink(path: &Path) -> Result<(), AgentError> {
    match path.symlink_metadata() {
        Ok(metadata) if metadata.is_symlink() || !metadata.is_dir() => Err(AgentError::Persistence),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(AgentError::Persistence),
    }
}

pub(crate) fn owned_path(root: &Path, id: SessionId) -> PathBuf {
    root.join("quick-chat").join(id.to_string())
}
