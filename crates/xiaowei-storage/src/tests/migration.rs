use crate::{sql::*, Database};

fn migration(name: &str, up: &[&str], down: &[&str]) -> DatabaseMigration {
    DatabaseMigration {
        name: name.into(),
        up: up.iter().map(|s| s.to_string()).collect(),
        down: down.iter().map(|s| s.to_string()).collect(),
    }
}

#[tokio::test]
async fn migration_and_marker_commit_together_and_down_is_ordered() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db.sqlite")).await.unwrap();
    let first = migration(
        "20260920000001_base",
        &["CREATE TABLE example(id INTEGER)"],
        &["DROP TABLE example"],
    );
    let mut second = migration(
        "20260920000002_extra",
        &["ALTER TABLE example ADD COLUMN label TEXT", "INVALID SQL"],
        &["ALTER TABLE example DROP COLUMN label"],
    );
    let mut registry = crate::clipboard_migrations::registry();
    registry.migrations.extend([first.clone(), second.clone()]);
    assert!(db.apply_migrations(registry.clone()).await.is_err());
    let state = db.migration_status(registry.clone()).await.unwrap();
    assert!(state.states[1].applied_at_seconds.is_some());
    assert!(state.states[2].applied_at_seconds.is_none());
    second.up.pop();
    registry.migrations[2] = second;
    let state = db.apply_migrations(registry.clone()).await.unwrap();
    assert_eq!(state, db.apply_migrations(registry.clone()).await.unwrap());
    assert!(db
        .rollback(DatabaseRollback {
            migrations: registry.migrations.clone(),
            name: first.name
        })
        .await
        .is_err());
    let state = db
        .rollback(DatabaseRollback {
            migrations: registry.migrations.clone(),
            name: registry.migrations[2].name.clone(),
        })
        .await
        .unwrap();
    assert!(state.states[2].applied_at_seconds.is_none());
    db.apply_migrations(registry).await.unwrap();
    db.close().await;
}

#[tokio::test]
async fn reopening_existing_clipboard_database_preserves_data_and_marker() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("storage.sqlite");
    let db = Database::open(&path).await.unwrap();
    sqlx::query(concat!(
        "INSERT INTO clipboard_items(hash,kind,text,created_at,last_used_at) ",
        "VALUES('existing','text','keep',1,2)"
    ))
    .execute(&db.pool)
    .await
    .unwrap();
    let marker: String = sqlx::query_scalar(concat!(
        "SELECT value FROM meta WHERE key=",
        "'migration_v2.20260920000000_clipboard_baseline'"
    ))
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let schema: Vec<(String, String)> =
        sqlx::query_as("SELECT name,sql FROM sqlite_master WHERE name LIKE 'clipboard_%' ORDER BY name")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    db.close().await;

    let reopened = Database::open(&path).await.unwrap();
    let preserved: (String, String) = sqlx::query_as(concat!(
        "SELECT text,value FROM clipboard_items,meta ",
        "WHERE hash='existing' AND key='migration_v2.20260920000000_clipboard_baseline'"
    ))
    .fetch_one(&reopened.pool)
    .await
    .unwrap();
    assert_eq!(preserved, ("keep".into(), marker));
    let reopened_schema: Vec<(String, String)> =
        sqlx::query_as("SELECT name,sql FROM sqlite_master WHERE name LIKE 'clipboard_%' ORDER BY name")
            .fetch_all(&reopened.pool)
            .await
            .unwrap();
    assert_eq!(reopened_schema, schema);
    reopened.close().await;
}
