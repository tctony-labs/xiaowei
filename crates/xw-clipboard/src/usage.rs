use std::path::Path;

// Run on a blocking worker. Ignore missing files during concurrent attachment deletion.
pub(crate) fn attachment_size(root: &Path) -> std::io::Result<u64> {
    let mut pending = vec![root.to_path_buf()];
    let mut total = 0;
    while let Some(directory) = pending.pop() {
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        for entry in entries {
            let path = entry?.path();
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                total += metadata.len();
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_nested_files_and_missing_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("clipboard");
        assert_eq!(attachment_size(&root).unwrap(), 0);
        std::fs::create_dir_all(root.join("images/nested")).unwrap();
        std::fs::create_dir(root.join("large_text")).unwrap();
        std::fs::write(root.join("images/nested/image.png"), b"image").unwrap();
        std::fs::write(root.join("large_text/hash"), b"text").unwrap();
        assert_eq!(attachment_size(&root).unwrap(), 9);
        std::fs::remove_file(root.join("images/nested/image.png")).unwrap();
        assert_eq!(attachment_size(&root).unwrap(), 4);
    }

    #[cfg(unix)]
    #[test]
    fn ignores_links_and_rejects_unreadable_directory_shape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("clipboard");
        std::fs::create_dir(&root).unwrap();
        let outside = dir.path().join("outside");
        std::fs::write(&outside, b"not an attachment").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        std::os::unix::fs::symlink(&root, root.join("cycle")).unwrap();
        assert_eq!(attachment_size(&root).unwrap(), 0);
        assert!(attachment_size(&outside).is_err());
    }
}
