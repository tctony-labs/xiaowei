use crate::{ClipboardItem, Result};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

pub(crate) struct Resources {
    directory: Option<tempfile::TempDir>,
}

impl Resources {
    pub fn new(root: &Path) -> Result<Self> {
        let mut builder = tempfile::Builder::new();
        builder.prefix("xiaowei-clipboard-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        Ok(Self {
            directory: Some(builder.tempdir_in(root)?),
        })
    }

    pub fn resolve(&self, item: ClipboardItem, index: Option<u32>) -> Result<Vec<String>> {
        let directory = self.directory.as_ref().ok_or("Clipboard resources closed")?;
        let paths = if item.kind == "file" {
            match index {
                Some(index) => vec![item.paths.get(index as usize).ok_or("Invalid file index")?.clone()],
                None => item.paths,
            }
        } else {
            if index.is_some() {
                return Err("Not a file record".into());
            }
            let path = match item.kind.as_str() {
                "image" => item.image_path.ok_or("Missing clipboard image path")?,
                "largeText" => item.text_path.ok_or("Missing clipboard text path")?,
                "text" => {
                    let text = item.text.ok_or("Missing clipboard text")?;
                    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
                    let path = directory.path().join(format!("{hash}.txt"));
                    let mut file = tempfile::NamedTempFile::new_in(directory.path())?;
                    file.write_all(text.as_bytes())?;
                    file.persist(&path)?;
                    path.to_str().ok_or("Invalid export path")?.to_owned()
                }
                _ => return Err("Unsupported clipboard type".into()),
            };
            vec![path]
        };
        if paths.is_empty()
            || paths
                .iter()
                .any(|path| !Path::new(path).is_absolute() || path.contains('\0'))
        {
            return Err("Invalid clipboard file path".into());
        }
        Ok(paths)
    }

    pub fn close(&mut self) -> Result<()> {
        if let Some(directory) = self.directory.take() {
            directory.close()?;
        }
        Ok(())
    }
}

pub(crate) fn path_text(paths: Vec<String>, directory: bool) -> Result<String> {
    if !directory {
        return Ok(paths.join("\n"));
    }
    let mut parents = Vec::<PathBuf>::new();
    for path in &paths {
        let path = Path::new(path);
        // Node dirname("/") preserves the root.
        let parent = path.parent().unwrap_or(path).to_path_buf();
        if !parents.contains(&parent) {
            parents.push(parent);
        }
    }
    Ok(parents
        .iter()
        .map(|path| path.to_str().ok_or("Invalid parent path"))
        .collect::<std::result::Result<Vec<_>, _>>()?
        .join("\n"))
}
