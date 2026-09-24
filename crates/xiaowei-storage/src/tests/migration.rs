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
    let first_index = registry.migrations.len();
    let second_index = first_index + 1;
    registry.migrations.extend([first.clone(), second.clone()]);
    assert!(db.apply_migrations(registry.clone()).await.is_err());
    let state = db.migration_status(registry.clone()).await.unwrap();
    assert!(state.states[first_index].applied_at_seconds.is_some());
    assert!(state.states[second_index].applied_at_seconds.is_none());
    second.up.pop();
    registry.migrations[second_index] = second;
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
            name: registry.migrations[second_index].name.clone(),
        })
        .await
        .unwrap();
    assert!(state.states[second_index].applied_at_seconds.is_none());
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

#[tokio::test]
async fn initialization_ignores_unknown_migrations_and_applies_known_pending_migrations() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("storage.sqlite");
    let db = Database::open(&path).await.unwrap();
    let mut newer_registry = crate::clipboard_migrations::registry();
    newer_registry.migrations.push(migration(
        "20260924000000_future",
        &[
            "CREATE TABLE future_data(value TEXT)",
            "INSERT INTO future_data VALUES('keep')",
        ],
        &["DROP TABLE future_data"],
    ));
    db.apply_migrations(newer_registry).await.unwrap();
    db.close().await;

    let reopened = Database::open(&path).await.unwrap();
    let mut current_registry = crate::clipboard_migrations::registry();
    current_registry.migrations.push(migration(
        "20260924000001_current",
        &["CREATE TABLE current_data(value TEXT)"],
        &["DROP TABLE current_data"],
    ));
    let states = reopened.apply_migrations(current_registry).await.unwrap();
    assert_eq!(states.states.len(), 2);
    assert!(states.states.iter().all(|state| state.applied_at_seconds.is_some()));

    let preserved: (String, String) = sqlx::query_as(
        "SELECT value,(SELECT value FROM meta WHERE key='migration_v2.20260924000000_future') FROM future_data",
    )
    .fetch_one(&reopened.pool)
    .await
    .unwrap();
    assert_eq!(preserved.0, "keep");
    assert!(!preserved.1.is_empty());
    sqlx::query("INSERT INTO current_data VALUES('initialized')")
        .execute(&reopened.pool)
        .await
        .unwrap();
    reopened.close().await;
}

#[tokio::test]
async fn initialization_reports_actual_migration_sql_failure() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("storage.sqlite");
    let db = Database::open(&path).await.unwrap();
    sqlx::query("DELETE FROM meta WHERE key='migration_v2.20260920000000_clipboard_baseline'")
        .execute(&db.pool)
        .await
        .unwrap();
    db.close().await;

    let error = Database::open(&path)
        .await
        .err()
        .expect("conflicting schema must fail initialization");
    assert!(
        error.to_string().contains("clipboard_categories already exists"),
        "{error}"
    );
}
