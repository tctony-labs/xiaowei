use crate::dao::DaoClient;
use crate::{ClipboardCategory, ClipboardData, ClipboardItem, ListOptions, Result};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use xw_contracts::xiaowei::clipboard as pb;
use xw_gateway::invoke::Client;

pub struct Store {
    dao: DaoClient,
    image_dir: PathBuf,
    text_dir: PathBuf,
}

impl Store {
    pub fn open(directory: &Path, client: Client) -> Result<Self> {
        let image_dir = directory.join("images");
        let text_dir = directory.join("large_text");
        std::fs::create_dir_all(&image_dir)?;
        std::fs::create_dir_all(&text_dir)?;
        Ok(Self {
            dao: DaoClient(client),
            image_dir,
            text_dir,
        })
    }

    pub fn set_client(&mut self, client: Client) {
        self.dao = DaoClient(client);
    }

    pub async fn initialize(&self) -> Result<()> {
        // Storage completes its fixed migrations before this owner is attached.
        Ok(())
    }

    fn attachment(&self, kind: &str, hash: &str) -> Option<PathBuf> {
        match kind {
            "image" => Some(self.image_dir.join(format!("{hash}.png"))),
            "largeText" => Some(self.text_dir.join(hash)),
            _ => None,
        }
    }

    async fn cleanup(&self, kind: &str, hash: &str) -> Result<()> {
        if let Some(path) = self.attachment(kind, hash) {
            if !self.dao.hash_referenced(hash.into()).await? {
                let _ = std::fs::remove_file(path);
            }
        }
        Ok(())
    }

    async fn cleanup_deleted(&self, deleted: &pb::DeletedClipboardEntities) -> Result<()> {
        for reference in &deleted.attachments {
            self.cleanup(&reference.kind, &reference.hash).await?;
        }
        Ok(())
    }

    pub async fn capture(&self, data: &ClipboardData) -> Result<ClipboardItem> {
        if data.is_empty() {
            return Err("Empty clipboard content".into());
        }
        let hash = data.hash();
        let (text, paths, width, height) = match data {
            ClipboardData::Text(text) => {
                if data.kind() == "largeText" {
                    write_file(&self.text_dir.join(&hash), text.as_bytes())?;
                }
                let stored = if data.kind() == "largeText" {
                    text.chars().take(500).collect()
                } else {
                    text.clone()
                };
                (Some(stored), vec![], None, None)
            }
            ClipboardData::Image { data, width, height } => {
                write_file(&self.image_dir.join(format!("{hash}.png")), data)?;
                (None, vec![], Some(*width), Some(*height))
            }
            ClipboardData::Files(paths) => (None, paths.clone(), None, None),
        };
        let record = self
            .dao
            .capture(pb::CaptureClipboardEntityRequest {
                hash,
                kind: data.kind().into(),
                text,
                paths,
                width,
                height,
                created_at_ms: current_time_ms()?,
            })
            .await?;
        Ok(self.map(record))
    }

    pub async fn list(&self, options: &ListOptions) -> Result<Vec<ClipboardItem>> {
        let kind = match options.kind.as_deref() {
            None => None,
            Some("image") => Some(pb::ClipboardKind::Image as i32),
            Some("file") => Some(pb::ClipboardKind::File as i32),
            _ => return Err("Invalid clipboard kind".into()),
        };
        let entities = self
            .dao
            .list(pb::ClipboardListOptions {
                query: Some(options.query.clone()),
                favorites_only: Some(options.favorites_only),
                kind,
                category_id: options.category_id.as_deref().map(str::parse).transpose()?,
                limit: Some(options.limit),
                offset: Some(options.offset),
            })
            .await?;
        Ok(entities.into_iter().map(|record| self.map(record)).collect())
    }

    pub async fn get(&self, id: i64) -> Result<Option<ClipboardItem>> {
        Ok(self.dao.get(record_id(id)?).await?.map(|record| self.map(record)))
    }

    pub async fn data(&self, id: i64) -> Result<ClipboardData> {
        let item = self.get(id).await?.ok_or("Clipboard item not found")?;
        match item.kind.as_str() {
            "text" => Ok(ClipboardData::Text(item.text.ok_or("Missing text")?)),
            "largeText" => Ok(ClipboardData::Text(std::fs::read_to_string(
                item.text_path.ok_or("Missing text path")?,
            )?)),
            "image" => Ok(ClipboardData::Image {
                data: std::fs::read(item.image_path.ok_or("Missing image path")?)?,
                width: item.width.ok_or("Missing image width")?,
                height: item.height.ok_or("Missing image height")?,
            }),
            "file" => Ok(ClipboardData::Files(item.paths)),
            _ => Err("Unknown clipboard content type".into()),
        }
    }

    pub async fn bump_use(&self, id: i64) -> Result<()> {
        self.dao.touch(record_id(id)?, current_time_ms()?).await
    }

    pub async fn set_favorite(&self, id: i64, favorite: bool) -> Result<bool> {
        self.dao.set_favorite(record_id(id)?, favorite).await
    }

    pub async fn set_remark(&self, id: i64, remark: &str) -> Result<()> {
        self.dao.set_remark(record_id(id)?, remark.into()).await
    }

    pub async fn set_category(&self, id: i64, category: Option<i64>) -> Result<()> {
        self.dao
            .set_category(record_id(id)?, category.map(record_id).transpose()?)
            .await
    }

    pub async fn categories(&self) -> Result<Vec<ClipboardCategory>> {
        Ok(self.dao.categories().await?.into_iter().map(category).collect())
    }

    pub async fn save_category(&self, id: Option<i64>, name: &str, color: &str) -> Result<ClipboardCategory> {
        let request = pb::SaveCategoryRequest {
            id: id.map(record_id).transpose()?,
            name: name.into(),
            color: color.into(),
        };
        Ok(category(self.dao.save_category(request).await?))
    }

    pub async fn delete_category(&self, id: i64) -> Result<()> {
        self.dao.delete_category(record_id(id)?).await
    }

    pub async fn edit_text(&self, id: i64, text: String) -> Result<ClipboardItem> {
        let data = ClipboardData::Text(text.clone());
        if data.is_empty() {
            return Err("Empty clipboard content".into());
        }
        let hash = data.hash();
        if data.kind() == "largeText" {
            write_file(&self.text_dir.join(&hash), text.as_bytes())?;
        }
        let stored = if data.kind() == "largeText" {
            text.chars().take(500).collect()
        } else {
            text
        };
        let result = match self
            .dao
            .edit_text(pb::EditClipboardEntityTextRequest {
                id: record_id(id)?,
                hash: hash.clone(),
                kind: data.kind().into(),
                text: stored,
                edited_at_ms: current_time_ms()?,
            })
            .await
        {
            Ok(result) => result,
            Err(error) => {
                let _ = self.cleanup(data.kind(), &hash).await;
                return Err(error);
            }
        };
        if let Some(reference) = result.previous_attachment {
            self.cleanup(&reference.kind, &reference.hash).await?;
        }
        Ok(self.map(result.entity.ok_or("Clipboard item disappeared")?))
    }

    pub async fn delete(&self, id: i64) -> Result<bool> {
        let result = self.dao.delete(record_id(id)?).await?;
        self.cleanup_deleted(&result).await?;
        Ok(result.deleted_count != 0)
    }

    pub async fn purge_ordinary_before(&self, cutoff_ms: i64) -> Result<usize> {
        let mut count = 0;
        loop {
            let result = self.dao.purge_ordinary_batch(cutoff_ms).await?;
            self.cleanup_deleted(&result).await?;
            count += result.deleted_count as usize;
            if result.deleted_count < 100 {
                return Ok(count);
            }
        }
    }

    pub async fn clear_history(&self) -> Result<usize> {
        let mut count = 0;
        loop {
            let result = self.dao.clear_history_batch().await?;
            self.cleanup_deleted(&result).await?;
            count += result.deleted_count as usize;
            if result.deleted_count < 100 {
                return Ok(count);
            }
        }
    }

    fn map(&self, record: pb::ClipboardEntity) -> ClipboardItem {
        let image_path = if record.kind == "image" {
            self.attachment(&record.kind, &record.hash)
                .map(|path| path.to_string_lossy().into_owned())
        } else {
            None
        };
        let text_path = if record.kind == "largeText" {
            self.attachment(&record.kind, &record.hash)
                .map(|path| path.to_string_lossy().into_owned())
        } else {
            None
        };
        ClipboardItem {
            id: record.id.to_string(),
            kind: record.kind,
            image_path,
            text_path,
            text: record.text,
            paths: record.paths,
            width: record.width,
            height: record.height,
            created_at: record.created_at_ms,
            last_used_at: record.last_used_at_ms,
            use_count: record.use_count,
            favorite: record.favorite,
            remark: record.remark,
            category_id: record.category_id.map(|id| id.to_string()),
        }
    }
}

fn record_id(id: i64) -> Result<u64> {
    Ok(u64::try_from(id)
        .ok()
        .filter(|id| *id > 0)
        .ok_or("Invalid clipboard ID")?)
}

fn category(value: pb::ClipboardCategory) -> ClipboardCategory {
    ClipboardCategory {
        id: value.id.to_string(),
        name: value.name,
        color: value.color,
    }
}

pub(crate) fn current_time_ms() -> Result<i64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64)
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    if path.is_file() {
        return Ok(());
    }
    let temporary = path.with_extension("tmp");
    let result = (|| -> Result<()> {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        std::fs::File::open(path.parent().ok_or("Missing attachment directory")?)?.sync_all()?;
        Ok(())
    })();
    let _ = std::fs::remove_file(temporary);
    result
}
