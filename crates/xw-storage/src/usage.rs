use crate::{Database, Result};
use std::path::Path;

impl Database {
    pub async fn database_usage(&self) -> Result<u64> {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || database_size(&path))
            .await
            .map_err(std::io::Error::other)?
    }
}

fn database_size(path: &Path) -> Result<u64> {
    let mut total = 0;
    for suffix in ["", "-wal", "-shm"] {
        let mut file = path.as_os_str().to_os_string();
        file.push(suffix);
        match std::fs::symlink_metadata(&file) {
            Ok(metadata) if metadata.is_file() => total += metadata.len(),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_wal_and_shm_and_handles_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("storage.sqlite");
        assert_eq!(database_size(&path).unwrap(), 0);
        std::fs::write(&path, b"database").unwrap();
        std::fs::write(dir.path().join("storage.sqlite-wal"), b"wal").unwrap();
        std::fs::write(dir.path().join("storage.sqlite-shm"), b"shm").unwrap();
        assert_eq!(database_size(&path).unwrap(), 14);
        std::fs::remove_file(dir.path().join("storage.sqlite-wal")).unwrap();
        assert_eq!(database_size(&path).unwrap(), 11);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_links_or_count_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("storage.sqlite");
        std::fs::write(dir.path().join("target"), b"target").unwrap();
        std::os::unix::fs::symlink(dir.path().join("target"), &path).unwrap();
        std::fs::create_dir(dir.path().join("storage.sqlite-wal")).unwrap();
        assert_eq!(database_size(&path).unwrap(), 0);
    }
}
