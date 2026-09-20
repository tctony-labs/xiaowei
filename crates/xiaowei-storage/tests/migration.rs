use xiaowei_storage::{pb::*, Database};

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
        "20260920000000_base",
        &["CREATE TABLE example(id INTEGER)"],
        &["DROP TABLE example"],
    );
    let mut second = migration(
        "20260920000001_extra",
        &["ALTER TABLE example ADD COLUMN label TEXT", "INVALID SQL"],
        &["ALTER TABLE example DROP COLUMN label"],
    );
    let mut registry = DatabaseMigrations {
        migrations: vec![first.clone(), second.clone()],
    };
    assert!(db.apply_migrations(registry.clone()).await.is_err());
    let state = db.migration_status(registry.clone()).await.unwrap();
    assert!(state.states[0].applied_at_seconds.is_some());
    assert!(state.states[1].applied_at_seconds.is_none());
    second.up.pop();
    registry.migrations[1] = second;
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
            name: registry.migrations[1].name.clone(),
        })
        .await
        .unwrap();
    assert!(state.states[1].applied_at_seconds.is_none());
    db.apply_migrations(registry).await.unwrap();
    db.close().await;
}
