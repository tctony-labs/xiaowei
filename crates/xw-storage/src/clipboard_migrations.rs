use crate::sql::{DatabaseMigration, DatabaseMigrations};

pub fn registry() -> DatabaseMigrations {
    DatabaseMigrations {
        migrations: vec![
            DatabaseMigration {
                name: "20260920000000_clipboard_baseline".into(),
                up: vec![
                    "CREATE TABLE clipboard_categories(
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL)"
                        .into(),
                    "CREATE TABLE clipboard_items(
                id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
                text TEXT, paths TEXT NOT NULL DEFAULT '[]', width INTEGER, height INTEGER,
                created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
                use_count INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0,
                remark TEXT, category_id INTEGER REFERENCES clipboard_categories(id) ON DELETE SET NULL)"
                        .into(),
                    "CREATE INDEX clipboard_items_recency ON clipboard_items(last_used_at DESC,id DESC)".into(),
                    "CREATE INDEX clipboard_items_category ON clipboard_items(category_id)".into(),
                ],
                down: vec![
                    "DROP TABLE clipboard_items".into(),
                    "DROP TABLE clipboard_categories".into(),
                ],
            },
            DatabaseMigration {
                name: "20260924000000_clipboard_fts".into(),
                up: vec![
                    "CREATE VIRTUAL TABLE clipboard_fts USING fts5(content, tokenize='xiaowei std')".into(),
                    "CREATE TRIGGER clipboard_fts_ai AFTER INSERT ON clipboard_items BEGIN
                    INSERT INTO clipboard_fts(rowid,content)
                    VALUES(NEW.id,coalesce(NEW.text,'') || ' ' || coalesce(NEW.remark,'') || ' ' || NEW.paths);
                END"
                    .into(),
                    "CREATE TRIGGER clipboard_fts_au AFTER UPDATE OF text,remark,paths ON clipboard_items BEGIN
                    DELETE FROM clipboard_fts WHERE rowid=OLD.id;
                    INSERT INTO clipboard_fts(rowid,content)
                    VALUES(NEW.id,coalesce(NEW.text,'') || ' ' || coalesce(NEW.remark,'') || ' ' || NEW.paths);
                END"
                    .into(),
                    "CREATE TRIGGER clipboard_fts_ad AFTER DELETE ON clipboard_items BEGIN
                    DELETE FROM clipboard_fts WHERE rowid=OLD.id;
                END"
                    .into(),
                    "INSERT INTO clipboard_fts(rowid,content)
                    SELECT id,coalesce(text,'') || ' ' || coalesce(remark,'') || ' ' || paths
                    FROM clipboard_items"
                        .into(),
                ],
                down: vec![
                    "DROP TRIGGER clipboard_fts_ad".into(),
                    "DROP TRIGGER clipboard_fts_au".into(),
                    "DROP TRIGGER clipboard_fts_ai".into(),
                    "DROP TABLE clipboard_fts".into(),
                ],
            },
        ],
    }
}
