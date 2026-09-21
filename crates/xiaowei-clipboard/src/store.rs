use crate::database::{reference, statement, value, DatabaseClient, Row};
use crate::{ClipboardCategory, ClipboardData, ClipboardItem, ListOptions, Result};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use xw_gateway::invoke::Client;

const COLUMNS: &str = "id,kind,text,paths,width,height,created_at,last_used_at,
    use_count,favorite,remark,category_id,hash";

pub struct Store {
    db: DatabaseClient,
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
            db: DatabaseClient(client),
            image_dir,
            text_dir,
        })
    }

    pub fn set_client(&mut self, client: Client) {
        self.db = DatabaseClient(client);
    }

    pub async fn initialize(&self) -> Result<()> {
        self.db.initialize().await
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
            if self
                .db
                .query("SELECT id FROM clipboard_items WHERE hash=?", vec![value(hash)])
                .await?
                .is_empty()
            {
                let _ = std::fs::remove_file(path);
            }
        }
        Ok(())
    }

    pub async fn capture(&self, data: &ClipboardData) -> Result<ClipboardItem> {
        if data.is_empty() {
            return Err("Empty clipboard content".into());
        }
        let now = now_ms()?;
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
                (Some(stored), "[]".into(), None, None)
            }
            ClipboardData::Image { data, width, height } => {
                write_file(&self.image_dir.join(format!("{hash}.png")), data)?;
                (None, "[]".into(), Some(*width), Some(*height))
            }
            ClipboardData::Files(paths) => (None, serde_json::to_string(paths)?, None, None),
        };
        let results = self
            .db
            .transaction(vec![statement(
                &format!(
                    "INSERT INTO clipboard_items(hash,kind,text,paths,width,height,created_at,last_used_at)
                VALUES(?1,?2,?3,?4,?5,?6,?7,?7)
                ON CONFLICT(hash) DO UPDATE SET last_used_at=excluded.last_used_at,use_count=clipboard_items.use_count+1
                RETURNING {COLUMNS}"
                ),
                vec![
                    value(&hash),
                    value(data.kind()),
                    value(text),
                    value(paths),
                    value(width),
                    value(height),
                    value(now),
                ],
            )])
            .await?;
        self.map(results[0].first().ok_or("Clipboard capture returned no row")?)
    }

    pub async fn list(&self, options: &ListOptions) -> Result<Vec<ClipboardItem>> {
        if !matches!(options.kind.as_deref(), None | Some("image" | "file")) {
            return Err("Invalid clipboard kind".into());
        }
        if options.limit == 0 || options.limit > 100 || options.query.len() > 4096 {
            return Err("Invalid clipboard list options".into());
        }
        let sql = format!(
            "SELECT {COLUMNS} FROM clipboard_items
            WHERE (?1=0 OR favorite=1)
            AND (?2='' OR instr(lower(coalesce(text,'') || ' ' || paths || ' ' || coalesce(remark,'')),lower(?2))>0)
            AND (?5 IS NULL OR kind=?5) AND (?6 IS NULL OR category_id=?6)
            ORDER BY last_used_at DESC,id DESC LIMIT ?3 OFFSET ?4"
        );
        self.db
            .query(
                &sql,
                vec![
                    value(options.favorites_only),
                    value(options.query.trim()),
                    value(options.limit),
                    value(options.offset),
                    value(options.kind.clone()),
                    value(options.category_id.clone()),
                ],
            )
            .await?
            .iter()
            .map(|row| self.map(row))
            .collect()
    }

    pub async fn get(&self, id: i64) -> Result<Option<ClipboardItem>> {
        self.db
            .query(
                &format!("SELECT {COLUMNS} FROM clipboard_items WHERE id=?"),
                vec![value(id)],
            )
            .await?
            .first()
            .map(|row| self.map(row))
            .transpose()
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
        self.db
            .execute(
                "UPDATE clipboard_items SET last_used_at=?1,use_count=use_count+1 WHERE id=?2",
                vec![value(now_ms()?), value(id)],
            )
            .await?;
        Ok(())
    }

    pub async fn set_favorite(&self, id: i64, favorite: bool) -> Result<bool> {
        Ok(self
            .db
            .execute(
                "UPDATE clipboard_items SET favorite=?1 WHERE id=?2",
                vec![value(favorite), value(id)],
            )
            .await?
            > 0)
    }

    pub async fn set_remark(&self, id: i64, remark: &str) -> Result<()> {
        if remark.len() > 65536 {
            return Err("Remark is too long".into());
        }
        let remark = remark.trim();
        let remark = if remark.is_empty() { None } else { Some(remark) };
        if self
            .db
            .execute(
                "UPDATE clipboard_items SET remark=?1 WHERE id=?2",
                vec![value(remark), value(id)],
            )
            .await?
            == 0
        {
            return Err("Clipboard item not found".into());
        }
        Ok(())
    }

    pub async fn set_category(&self, id: i64, category: Option<i64>) -> Result<()> {
        if self
            .db
            .execute(
                "UPDATE clipboard_items SET category_id=?1 WHERE id=?2",
                vec![value(category), value(id)],
            )
            .await?
            == 0
        {
            return Err("Clipboard item not found".into());
        }
        Ok(())
    }

    pub async fn categories(&self) -> Result<Vec<ClipboardCategory>> {
        self.db
            .query("SELECT id,name,color FROM clipboard_categories ORDER BY id", vec![])
            .await?
            .iter()
            .map(map_category)
            .collect()
    }

    pub async fn save_category(&self, id: Option<i64>, name: &str, color: &str) -> Result<ClipboardCategory> {
        let name = name.trim();
        if name.is_empty()
            || name.len() > 256
            || color.len() != 7
            || !color.starts_with('#')
            || !color[1..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Invalid category name or color".into());
        }
        let step = if let Some(id) = id {
            statement(
                "UPDATE clipboard_categories SET name=?1,color=?2 WHERE id=?3 RETURNING id,name,color",
                vec![value(name), value(color), value(id)],
            )
        } else {
            statement(
                "INSERT INTO clipboard_categories(name,color) VALUES(?1,?2) RETURNING id,name,color",
                vec![value(name), value(color)],
            )
        };
        let rows = self.db.transaction(vec![step]).await?;
        map_category(rows[0].first().ok_or("Category not found")?)
    }

    pub async fn delete_category(&self, id: i64) -> Result<()> {
        if self
            .db
            .execute("DELETE FROM clipboard_categories WHERE id=?", vec![value(id)])
            .await?
            == 0
        {
            return Err("Category not found".into());
        }
        Ok(())
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
        let mut source = statement(
            "SELECT favorite,remark,category_id,hash,kind FROM clipboard_items
            WHERE id=? AND kind IN ('text','largeText')",
            vec![value(id)],
        );
        source.expected_rows = Some(1);
        let mut target = statement(
            "SELECT coalesce((SELECT id FROM clipboard_items WHERE hash=?1),?2)",
            vec![value(&hash), value(id)],
        );
        target.expected_rows = Some(1);
        let steps = vec![
            source,
            target,
            statement(
                "UPDATE clipboard_items SET favorite=favorite OR ?1,
                remark=CASE WHEN ?2 IS NULL THEN remark WHEN remark IS NULL OR remark=?2 THEN ?2
                    ELSE ?2||';'||remark END,
                category_id=coalesce(?3,category_id),last_used_at=?4,use_count=use_count+1
                WHERE id=?5 AND id<>?6",
                vec![
                    reference(0, 0),
                    reference(0, 1),
                    reference(0, 2),
                    value(now_ms()?),
                    reference(1, 0),
                    value(id),
                ],
            ),
            statement(
                "DELETE FROM clipboard_items WHERE id=?1 AND id<>?2",
                vec![value(id), reference(1, 0)],
            ),
            statement(
                "UPDATE clipboard_items SET hash=?1,kind=?2,text=?3,last_used_at=?4,use_count=use_count+1
                WHERE id=?5 AND id=?6",
                vec![
                    value(&hash),
                    value(data.kind()),
                    value(stored),
                    value(now_ms()?),
                    value(id),
                    reference(1, 0),
                ],
            ),
            statement(
                &format!("SELECT {COLUMNS} FROM clipboard_items WHERE id=?"),
                vec![reference(1, 0)],
            ),
        ];
        let result = match self.db.transaction(steps).await {
            Ok(result) => result,
            Err(error) => {
                // Never remove a file unless the database confirms it is unreferenced.
                let _ = self.cleanup(data.kind(), &hash).await;
                return Err(error);
            }
        };
        self.cleanup(&result[0][0].get::<String>(4)?, &result[0][0].get::<String>(3)?)
            .await?;
        self.map(result[5].first().ok_or("Clipboard item disappeared")?)
    }

    pub async fn delete(&self, id: i64) -> Result<bool> {
        let result = self
            .db
            .transaction(vec![statement(
                "DELETE FROM clipboard_items WHERE id=? RETURNING kind,hash",
                vec![value(id)],
            )])
            .await?;
        for row in &result[0] {
            self.cleanup(&row.get::<String>(0)?, &row.get::<String>(1)?).await?;
        }
        Ok(!result[0].is_empty())
    }

    pub async fn clear_history(&self) -> Result<usize> {
        // Delete in bounded batches so returned attachment keys cannot exceed DB result limits.
        let mut count = 0;
        loop {
            let result = self
                .db
                .transaction(vec![statement(
                    "DELETE FROM clipboard_items WHERE id IN
                (SELECT id FROM clipboard_items WHERE favorite=0 LIMIT 100) RETURNING kind,hash",
                    vec![],
                )])
                .await?;
            for row in &result[0] {
                self.cleanup(&row.get::<String>(0)?, &row.get::<String>(1)?).await?;
            }
            count += result[0].len();
            if result[0].len() < 100 {
                return Ok(count);
            }
        }
    }

    fn map(&self, row: &Row) -> Result<ClipboardItem> {
        let kind: String = row.get(1)?;
        let hash: String = row.get(12)?;
        Ok(ClipboardItem {
            id: row.get::<i64>(0)?.to_string(),
            image_path: if kind == "image" {
                self.attachment(&kind, &hash).map(|p| p.to_string_lossy().into_owned())
            } else {
                None
            },
            text_path: if kind == "largeText" {
                self.attachment(&kind, &hash).map(|p| p.to_string_lossy().into_owned())
            } else {
                None
            },
            kind,
            text: row.get(2)?,
            paths: serde_json::from_str(&row.get::<String>(3)?)?,
            width: row.get(4)?,
            height: row.get(5)?,
            created_at: row.get(6)?,
            last_used_at: row.get(7)?,
            use_count: row.get(8)?,
            favorite: row.get(9)?,
            remark: row.get(10)?,
            category_id: row.get::<Option<i64>>(11)?.map(|id| id.to_string()),
        })
    }
}

fn map_category(row: &Row) -> Result<ClipboardCategory> {
    Ok(ClipboardCategory {
        id: row.get::<i64>(0)?.to_string(),
        name: row.get(1)?,
        color: row.get(2)?,
    })
}

fn now_ms() -> Result<i64> {
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
