use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::client::InspectError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Workspace,
    App,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub kind: SourceKind,
    pub path: String,
}

impl Source {
    pub fn resolve(workspace: Option<&Path>) -> Result<Self, InspectError> {
        if let Some(path) = workspace {
            return Self::canonical(SourceKind::Workspace, path);
        }
        let executable = std::env::current_exe()
            .and_then(fs::canonicalize)
            .map_err(|error| InspectError::new("INVALID_SOURCE", error.to_string()))?;
        let bundle = executable.ancestors().find(|path| {
            path.extension().is_some_and(|extension| extension == "app")
                && path.join("Contents/Info.plist").is_file()
        });
        let Some(bundle) = bundle else {
            return Err(InspectError::new(
                "INVALID_SOURCE",
                "Run just inspect in the workspace, or use the CLI inside the target App",
            ));
        };
        Self::canonical(SourceKind::App, bundle)
    }

    fn canonical(kind: SourceKind, path: &Path) -> Result<Self, InspectError> {
        if !path.is_absolute() || !path.is_dir() {
            return Err(InspectError::new(
                "INVALID_SOURCE",
                "Source must be an existing absolute directory",
            ));
        }
        let canonical = fs::canonicalize(path)
            .map_err(|error| InspectError::new("INVALID_SOURCE", error.to_string()))?;
        let path = canonical
            .to_str()
            .ok_or_else(|| InspectError::new("INVALID_SOURCE", "Source must be valid UTF-8"))?;
        Ok(Self {
            kind,
            path: path.to_owned(),
        })
    }

    pub fn socket_path(&self, uid: u32) -> PathBuf {
        let kind = match self.kind {
            SourceKind::Workspace => "workspace",
            SourceKind::App => "app",
        };
        let digest = Sha256::digest(format!("{kind}\0{}", self.path).as_bytes());
        Path::new("/tmp")
            .join(format!("xiaowei-{uid}"))
            .join(format!("{digest:x}.sock"))
    }
}

pub fn user_id() -> u32 {
    // getuid only reads the calling process's real user ID.
    unsafe { libc::getuid() }
}

pub fn validate_socket(path: &Path) -> Result<(), InspectError> {
    let directory = path.parent().expect("socket path has a parent");
    let inspect = |path: &Path| {
        fs::symlink_metadata(path).map_err(|error| {
            let code = if error.kind() == std::io::ErrorKind::NotFound {
                "APP_NOT_RUNNING"
            } else {
                "CONNECTION_FAILED"
            };
            InspectError::new(code, format!("{}: {error}", path.display()))
        })
    };
    let parent = inspect(directory)?;
    let socket = inspect(path)?;
    if !parent.is_dir()
        || parent.uid() != user_id()
        || parent.mode() & 0o077 != 0
        || !socket.file_type().is_socket()
        || socket.uid() != user_id()
        || socket.mode() & 0o077 != 0
    {
        return Err(InspectError::new(
            "UNSAFE_SOCKET",
            "Socket and its directory must be private, owned, and not symbolic links",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_match_the_shared_protocol_vectors() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/targets.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let source: Source = serde_json::from_value(case["source"].clone()).unwrap();
            let path = source.socket_path(case["uid"].as_u64().unwrap() as u32);
            assert_eq!(path.to_str().unwrap(), case["socket"].as_str().unwrap());
        }
    }
}
