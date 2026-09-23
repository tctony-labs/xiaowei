use crate::sql::{DatabaseMigration, DatabaseMigrations};

pub fn registry() -> DatabaseMigrations {
    DatabaseMigrations {
        migrations: vec![DatabaseMigration {
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
        }],
    }
}
