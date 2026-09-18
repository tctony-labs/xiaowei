use crate::{ClipboardCategory, ClipboardData, ClipboardItem, ListOptions, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const COLUMNS: &str = "id,kind,CASE WHEN kind='largeText' THEN substr(text,1,500) ELSE text END,
    paths,width,height,created_at,last_used_at,use_count,favorite,remark,category_id,hash";

pub struct Store {
    db: Connection,
    image_dir: PathBuf,
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(directory)?;
        let db = Connection::open(directory.join("history.sqlite"))?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
        let version: u32 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 3 {
            return Err("Clipboard database version is newer than this application".into());
        }
        if version == 0 {
            db.execute_batch(
                "BEGIN IMMEDIATE;
                CREATE TABLE items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
                    text TEXT, png BLOB, paths TEXT NOT NULL DEFAULT '[]', width INTEGER, height INTEGER,
                    created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
                    use_count INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX items_recency ON items(last_used_at DESC, id DESC);
                PRAGMA user_version=1;
                COMMIT;",
            )?;
        }
        if version < 2 {
            db.execute_batch(
                "BEGIN IMMEDIATE;
                CREATE TABLE categories(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL);
                ALTER TABLE items ADD COLUMN remark TEXT;
                ALTER TABLE items ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
                CREATE INDEX items_category ON items(category_id);
                PRAGMA user_version=2;
                COMMIT;",
            )?;
        }
        db.execute_batch("PRAGMA foreign_keys=ON;")?;
        let image_dir = directory.join("images");
        std::fs::create_dir_all(&image_dir)?;
        if version < 3 {
            // Keep blobs until every file has been durably written; failures are safe to retry.
            let mut query = db.prepare("SELECT hash,png FROM items WHERE kind='image'")?;
            let images = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)))?;
            for image in images {
                let (hash, bytes) = image?;
                write_image(&image_dir.join(format!("{hash}.png")), &bytes)?;
            }
            db.execute_batch("BEGIN IMMEDIATE; ALTER TABLE items DROP COLUMN png; PRAGMA user_version=3; COMMIT;")?;
        }
        Ok(Self { db, image_dir })
    }

    pub fn capture(&self, data: &ClipboardData) -> Result<ClipboardItem> {
        if data.is_empty() {
            return Err("Empty clipboard content".into());
        }
        let now = now_ms()?;
        let hash = data.hash();
        let (text, paths, width, height) = match data {
            ClipboardData::Text(text) => (Some(text.as_str()), "[]".into(), None, None),
            ClipboardData::Image { data, width, height } => {
                write_image(&self.image_dir.join(format!("{hash}.png")), data)?;
                (None, "[]".into(), Some(*width), Some(*height))
            }
            ClipboardData::Files(paths) => (None, serde_json::to_string(paths)?, None, None),
        };
        // One atomic statement preserves the identity and favorite state on repeated captures.
        let id: i64 = self.db.query_row(
            "INSERT INTO items(hash,kind,text,paths,width,height,created_at,last_used_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?7)
             ON CONFLICT(hash) DO UPDATE SET last_used_at=excluded.last_used_at,use_count=items.use_count+1
             RETURNING id",
            params![hash, data.kind(), text, paths, width, height, now],
            |row| row.get(0),
        )?;
        self.get(id)?.ok_or_else(|| "Clipboard item disappeared".into())
    }

    pub fn list(&self, options: &ListOptions) -> Result<Vec<ClipboardItem>> {
        if !matches!(options.kind.as_deref(), None | Some("image" | "file")) {
            return Err("Invalid clipboard kind".into());
        }
        if options.limit == 0 || options.limit > 100 || options.query.len() > 4096 {
            return Err("Invalid clipboard list options".into());
        }
        let sql = format!(
            "SELECT {COLUMNS} FROM items
             WHERE (?1=0 OR favorite=1)
               AND (?2='' OR instr(lower(coalesce(text,'') || ' ' || paths || ' ' || coalesce(remark,'')),lower(?2))>0)
             AND (?5 IS NULL OR kind=?5) AND (?6 IS NULL OR category_id=?6)
             ORDER BY last_used_at DESC,id DESC LIMIT ?3 OFFSET ?4"
        );
        let mut statement = self.db.prepare(&sql)?;
        let rows = statement.query_map(
            params![
                options.favorites_only,
                options.query.trim(),
                options.limit,
                options.offset,
                options.kind,
                options.category_id
            ],
            |row| map_item(row, &self.image_dir),
        )?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn get(&self, id: i64) -> Result<Option<ClipboardItem>> {
        Ok(self
            .db
            .query_row(&format!("SELECT {COLUMNS} FROM items WHERE id=?1"), [id], |row| {
                map_item(row, &self.image_dir)
            })
            .optional()?)
    }

    pub fn data(&self, id: i64) -> Result<ClipboardData> {
        let kind: String = self
            .db
            .query_row("SELECT kind FROM items WHERE id=?1", [id], |row| row.get(0))?;
        match kind.as_str() {
            "text" | "largeText" => Ok(ClipboardData::Text(self.db.query_row(
                "SELECT text FROM items WHERE id=?1",
                [id],
                |row| row.get(0),
            )?)),
            "image" => {
                let item = self.get(id)?.ok_or("Clipboard item not found")?;
                Ok(ClipboardData::Image {
                    data: std::fs::read(item.image_path.ok_or("Missing image path")?)?,
                    width: item.width.ok_or("Missing image width")?,
                    height: item.height.ok_or("Missing image height")?,
                })
            }
            "file" => {
                let json: String = self
                    .db
                    .query_row("SELECT paths FROM items WHERE id=?1", [id], |row| row.get(0))?;
                Ok(ClipboardData::Files(serde_json::from_str(&json)?))
            }
            _ => Err("Unknown clipboard content type".into()),
        }
    }

    pub fn bump_use(&self, id: i64) -> Result<()> {
        self.db.execute(
            "UPDATE items SET last_used_at=?1,use_count=use_count+1 WHERE id=?2",
            params![now_ms()?, id],
        )?;
        Ok(())
    }

    pub fn set_favorite(&self, id: i64, favorite: bool) -> Result<bool> {
        Ok(self
            .db
            .execute("UPDATE items SET favorite=?1 WHERE id=?2", params![favorite, id])?
            > 0)
    }

    pub fn set_remark(&self, id: i64, remark: &str) -> Result<()> {
        if remark.len() > 65536 {
            return Err("Remark is too long".into());
        }
        let value = remark.trim();
        let value = if value.is_empty() { None } else { Some(value) };
        if self
            .db
            .execute("UPDATE items SET remark=?1 WHERE id=?2", params![value, id])?
            == 0
        {
            return Err("Clipboard item not found".into());
        }
        Ok(())
    }

    pub fn set_category(&self, id: i64, category: Option<i64>) -> Result<()> {
        if self
            .db
            .execute("UPDATE items SET category_id=?1 WHERE id=?2", params![category, id])?
            == 0
        {
            return Err("Clipboard item not found".into());
        }
        Ok(())
    }

    pub fn categories(&self) -> Result<Vec<ClipboardCategory>> {
        let mut query = self.db.prepare("SELECT id,name,color FROM categories ORDER BY id")?;
        let categories = query
            .query_map([], |row| {
                Ok(ClipboardCategory {
                    id: row.get::<_, i64>(0)?.to_string(),
                    name: row.get(1)?,
                    color: row.get(2)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(categories)
    }

    pub fn save_category(&self, id: Option<i64>, name: &str, color: &str) -> Result<ClipboardCategory> {
        let name = name.trim();
        if name.is_empty()
            || name.len() > 256
            || color.len() != 7
            || !color.starts_with('#')
            || !color[1..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Invalid category name or color".into());
        }
        let id = match id {
            Some(id) => {
                if self.db.execute(
                    "UPDATE categories SET name=?1,color=?2 WHERE id=?3",
                    params![name, color, id],
                )? == 0
                {
                    return Err("Category not found".into());
                }
                id
            }
            None => {
                self.db
                    .execute("INSERT INTO categories(name,color) VALUES(?1,?2)", params![name, color])?;
                self.db.last_insert_rowid()
            }
        };
        Ok(ClipboardCategory {
            id: id.to_string(),
            name: name.into(),
            color: color.into(),
        })
    }

    pub fn delete_category(&self, id: i64) -> Result<()> {
        // Foreign key ON DELETE SET NULL preserves the records and their favorite state.
        if self.db.execute("DELETE FROM categories WHERE id=?1", [id])? == 0 {
            return Err("Category not found".into());
        }
        Ok(())
    }

    pub fn edit_text(&mut self, id: i64, text: String) -> Result<ClipboardItem> {
        let source = self.get(id)?.ok_or("Clipboard item not found")?;
        if source.kind != "text" && source.kind != "largeText" {
            return Err("Clipboard item is not text".into());
        }
        let data = ClipboardData::Text(text.clone());
        if data.is_empty() {
            return Err("Empty clipboard content".into());
        }
        let hash = data.hash();
        let tx = self.db.transaction()?;
        let target = tx
            .query_row(&format!("SELECT {COLUMNS} FROM items WHERE hash=?1"), [&hash], |row| {
                map_item(row, &self.image_dir)
            })
            .optional()?;
        let result_id = if let Some(target) = target.filter(|item| item.id != source.id) {
            let remark = match (source.remark.as_deref(), target.remark.as_deref()) {
                (Some(a), Some(b)) if a != b => Some(format!("{a};{b}")),
                (Some(a), _) => Some(a.to_string()),
                (_, b) => b.map(str::to_string),
            };
            let target_id: i64 = target.id.parse()?;
            tx.execute("UPDATE items SET favorite=?1,remark=?2,category_id=?3,last_used_at=?4,use_count=use_count+1 WHERE id=?5",
                params![source.favorite || target.favorite, remark, source.category_id.or(target.category_id), now_ms()?, target_id])?;
            tx.execute("DELETE FROM items WHERE id=?1", [id])?;
            target_id
        } else {
            tx.execute(
                "UPDATE items SET hash=?1,kind=?2,text=?3,last_used_at=?4,use_count=use_count+1 WHERE id=?5",
                params![hash, data.kind(), text, now_ms()?, id],
            )?;
            id
        };
        tx.commit()?;
        self.get(result_id)?.ok_or_else(|| "Clipboard item disappeared".into())
    }

    pub fn delete(&self, id: i64) -> Result<bool> {
        if let Some(path) = self.get(id)?.and_then(|item| item.image_path) {
            // Match the old application's best-effort attachment cleanup.
            let _ = std::fs::remove_file(path);
        }
        Ok(self.db.execute("DELETE FROM items WHERE id=?1", [id])? > 0)
    }

    pub fn clear_history(&self) -> Result<usize> {
        let mut query = self.db.prepare("SELECT id FROM items WHERE favorite=0")?;
        let ids = query
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in &ids {
            self.delete(*id)?;
        }
        Ok(ids.len())
    }
}

fn now_ms() -> Result<i64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as i64)
}

fn map_item(row: &rusqlite::Row<'_>, image_dir: &Path) -> rusqlite::Result<ClipboardItem> {
    let raw: String = row.get(3)?;
    let paths = serde_json::from_str(&raw)
        .map_err(|error| rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error)))?;
    Ok(ClipboardItem {
        id: row.get::<_, i64>(0)?.to_string(),
        kind: row.get(1)?,
        image_path: if row.get::<_, String>(1)? == "image" {
            Some(
                image_dir
                    .join(format!("{}.png", row.get::<_, String>(12)?))
                    .to_string_lossy()
                    .into_owned(),
            )
        } else {
            None
        },
        text: row.get(2)?,
        paths,
        width: row.get(4)?,
        height: row.get(5)?,
        created_at: row.get(6)?,
        last_used_at: row.get(7)?,
        use_count: row.get(8)?,
        favorite: row.get(9)?,
        remark: row.get(10)?,
        category_id: row.get::<_, Option<i64>>(11)?.map(|id| id.to_string()),
    })
}

fn write_image(path: &Path, bytes: &[u8]) -> Result<()> {
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
        std::fs::File::open(path.parent().ok_or("Missing image directory")?)?.sync_all()?;
        Ok(())
    })();
    let _ = std::fs::remove_file(temporary);
    result
}
