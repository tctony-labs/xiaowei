use crate::{clipboard_dao::ClipboardDao, clipboard_migrations, sql::DatabaseRollback, Database};
use proto_desktop_rs::xiaowei::desktop::clipboard as pb;
use std::sync::Arc;

async fn capture(dao: &ClipboardDao, text: &str, time: i64) -> pb::ClipboardEntity {
    dao.capture(pb::CaptureClipboardEntityRequest {
        hash: text.into(),
        kind: "text".into(),
        text: Some(text.into()),
        created_at_ms: time,
        ..Default::default()
    })
    .await
    .unwrap()
}

async fn get(dao: &ClipboardDao, id: u64) -> pb::ClipboardEntity {
    dao.get(pb::ClipboardItemRequest { id })
        .await
        .unwrap()
        .entity
        .unwrap()
}

async fn edit(dao: &ClipboardDao, id: u64, text: &str, time: i64) -> pb::ClipboardEntity {
    dao.edit_text(pb::EditClipboardEntityTextRequest {
        id,
        hash: text.into(),
        kind: "text".into(),
        text: text.into(),
        edited_at_ms: time,
    })
    .await
    .unwrap()
    .entity
    .unwrap()
}

#[tokio::test]
async fn edits_only_refresh_modification_time_when_content_or_merged_metadata_changes() {
    let directory = tempfile::tempdir().unwrap();
    let database = Arc::new(
        Database::open(&directory.path().join("db.sqlite"))
            .await
            .unwrap(),
    );
    let dao = ClipboardDao::new(database.clone());
    capture(&dao, "source", 10).await;
    let source = capture(&dao, "source", 11).await;
    capture(&dao, "target", 20).await;
    capture(&dao, "target", 21).await;
    let target = capture(&dao, "target", 22).await;
    assert_eq!(source.updated_at_ms, 10);
    assert_eq!(target.updated_at_ms, 20);

    let edited = edit(&dao, source.id, "edited", 30).await;
    let mut expected = source.clone();
    expected.hash = "edited".into();
    expected.text = Some("edited".into());
    expected.updated_at_ms = 30;
    assert_eq!(edited, expected);
    assert_eq!(edit(&dao, source.id, "edited", 40).await, edited);
    let listed = dao.list(pb::ClipboardListOptions::default()).await.unwrap();
    assert_eq!(listed.entities, vec![target.clone(), edited]);

    assert_eq!(edit(&dao, source.id, "target", 50).await, target);
    assert!(dao
        .get(pb::ClipboardItemRequest { id: source.id })
        .await
        .unwrap()
        .entity
        .is_none());

    let category = dao
        .save_category(pb::SaveCategoryRequest {
            name: "work".into(),
            color: "#123456".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let mut merged = target.clone();
    merged.favorite = true;
    merged.remark = Some("note".into());
    merged.category_id = Some(category.id);
    merged.updated_at_ms = 60;

    for (text, time) in [("metadata", 60), ("same metadata", 70)] {
        let source = capture(&dao, text, 1).await;
        dao.set_favorite(pb::FavoriteRequest {
            id: source.id,
            favorite: true,
        })
        .await
        .unwrap();
        dao.set_remark(pb::SetRemarkRequest {
            id: source.id,
            remark: "note".into(),
        })
        .await
        .unwrap();
        dao.set_category(pb::SetCategoryRequest {
            id: source.id,
            category_id: Some(category.id),
        })
        .await
        .unwrap();
        assert_eq!(edit(&dao, source.id, "target", time).await, merged);
    }

    assert!(dao
        .edit_text(pb::EditClipboardEntityTextRequest {
            id: u64::MAX,
            hash: "target".into(),
            kind: "text".into(),
            text: "target".into(),
            edited_at_ms: 80,
        })
        .await
        .is_err());
    assert_eq!(get(&dao, target.id).await, merged);

    dao.touch(pb::TouchClipboardEntityRequest {
        id: target.id,
        used_at_ms: 90,
    })
    .await
    .unwrap();
    merged.last_used_at_ms = 90;
    merged.use_count += 1;
    assert_eq!(get(&dao, target.id).await, merged);
    database.close().await;
}

#[tokio::test]
async fn metadata_updates_and_category_deletion_preserve_usage_and_ignore_unchanged_values() {
    let directory = tempfile::tempdir().unwrap();
    let database = Arc::new(
        Database::open(&directory.path().join("db.sqlite"))
            .await
            .unwrap(),
    );
    let dao = ClipboardDao::new(database.clone());
    let source = capture(&dao, "source", 10).await;
    let untouched = capture(&dao, "untouched", 20).await;

    assert!(
        dao.set_favorite(pb::FavoriteRequest {
            id: source.id,
            favorite: true
        })
        .await
        .unwrap()
        .updated
    );
    assert!(get(&dao, source.id).await.updated_at_ms > 10);
    sqlx::query("UPDATE clipboard_items SET updated_at=10 WHERE id=?")
        .bind(source.id as i64)
        .execute(&database.pool)
        .await
        .unwrap();
    let favorite = get(&dao, source.id).await;
    assert!(
        dao.set_favorite(pb::FavoriteRequest {
            id: source.id,
            favorite: true
        })
        .await
        .unwrap()
        .updated
    );
    assert_eq!(get(&dao, source.id).await, favorite);
    dao.set_favorite(pb::FavoriteRequest {
        id: source.id,
        favorite: false,
    })
    .await
    .unwrap();
    assert!(get(&dao, source.id).await.updated_at_ms > 10);

    dao.set_remark(pb::SetRemarkRequest {
        id: source.id,
        remark: " note ".into(),
    })
    .await
    .unwrap();
    sqlx::query("UPDATE clipboard_items SET updated_at=10 WHERE id=?")
        .bind(source.id as i64)
        .execute(&database.pool)
        .await
        .unwrap();
    let remarked = get(&dao, source.id).await;
    assert_eq!(remarked.remark.as_deref(), Some("note"));
    dao.set_remark(pb::SetRemarkRequest {
        id: source.id,
        remark: "note".into(),
    })
    .await
    .unwrap();
    assert_eq!(get(&dao, source.id).await, remarked);
    assert!(dao
        .set_remark(pb::SetRemarkRequest {
            id: source.id,
            remark: "x".repeat(65537)
        })
        .await
        .is_err());
    assert_eq!(get(&dao, source.id).await, remarked);
    dao.set_remark(pb::SetRemarkRequest {
        id: source.id,
        remark: String::new(),
    })
    .await
    .unwrap();
    assert!(get(&dao, source.id).await.updated_at_ms > 10);

    let category = dao
        .save_category(pb::SaveCategoryRequest {
            name: "work".into(),
            color: "#123456".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    dao.set_category(pb::SetCategoryRequest {
        id: source.id,
        category_id: Some(category.id),
    })
    .await
    .unwrap();
    sqlx::query("UPDATE clipboard_items SET updated_at=10 WHERE id=?")
        .bind(source.id as i64)
        .execute(&database.pool)
        .await
        .unwrap();
    let assigned = get(&dao, source.id).await;
    dao.set_category(pb::SetCategoryRequest {
        id: source.id,
        category_id: Some(category.id),
    })
    .await
    .unwrap();
    assert_eq!(get(&dao, source.id).await, assigned);
    assert!(dao
        .set_category(pb::SetCategoryRequest {
            id: source.id,
            category_id: Some(99999)
        })
        .await
        .is_err());
    assert_eq!(get(&dao, source.id).await, assigned);

    dao.delete_category(pb::ClipboardCategoryRequest { id: category.id })
        .await
        .unwrap();
    let unassigned = get(&dao, source.id).await;
    assert!(unassigned.category_id.is_none());
    assert!(unassigned.updated_at_ms > 10);
    assert_eq!(unassigned.created_at_ms, source.created_at_ms);
    assert_eq!(unassigned.last_used_at_ms, source.last_used_at_ms);
    assert_eq!(unassigned.use_count, source.use_count);
    assert_eq!(get(&dao, untouched.id).await, untouched);
    database.close().await;
}

#[tokio::test]
async fn modification_time_upgrade_uses_previous_recency_and_survives_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("db.sqlite");
    let database = Database::open(&path).await.unwrap();
    let registry = clipboard_migrations::registry();
    let migration = registry.migrations.last().unwrap().name.clone();
    assert_eq!(migration, "20261025000001_clipboard_updated_at");
    database
        .rollback(DatabaseRollback {
            name: migration,
            migrations: registry.migrations,
        })
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO clipboard_items(id,hash,kind,text,created_at,last_used_at,use_count,favorite)
        VALUES(7,'existing','text','keep',10,20,3,1)",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    database.close().await;

    for _ in 0..2 {
        let database = Arc::new(Database::open(&path).await.unwrap());
        let dao = ClipboardDao::new(database.clone());
        let existing = get(&dao, 7).await;
        assert_eq!(existing.created_at_ms, 10);
        assert_eq!(existing.last_used_at_ms, 20);
        assert_eq!(existing.updated_at_ms, 20);
        assert_eq!(existing.use_count, 3);
        assert!(existing.favorite);
        assert_eq!(existing.text.as_deref(), Some("keep"));
        assert_eq!(existing.hash, "existing");
        database.close().await;
    }
}

#[tokio::test]
async fn ordinary_cleanup_requires_both_usage_and_modification_to_be_before_the_cutoff() {
    let directory = tempfile::tempdir().unwrap();
    let database = Arc::new(
        Database::open(&directory.path().join("db.sqlite"))
            .await
            .unwrap(),
    );
    let dao = ClipboardDao::new(database.clone());
    let expired = capture(&dao, "expired", 10).await;
    let used = capture(&dao, "used", 10).await;
    let edited = capture(&dao, "original", 10).await;
    let boundary = capture(&dao, "boundary", 30).await;
    dao.touch(pb::TouchClipboardEntityRequest {
        id: used.id,
        used_at_ms: 31,
    })
    .await
    .unwrap();
    let edited = edit(&dao, edited.id, "edited", 31).await;
    let deleted = dao
        .purge_ordinary_batch(pb::PurgeClipboardEntitiesRequest { cutoff_ms: 30 })
        .await
        .unwrap();
    assert_eq!(deleted.deleted_count, 1);
    assert!(dao
        .get(pb::ClipboardItemRequest { id: expired.id })
        .await
        .unwrap()
        .entity
        .is_none());
    assert_eq!(get(&dao, edited.id).await, edited);
    assert_eq!(get(&dao, boundary.id).await, boundary);
    assert_eq!(get(&dao, used.id).await.last_used_at_ms, 31);
    assert_eq!(
        dao.purge_ordinary_batch(pb::PurgeClipboardEntitiesRequest { cutoff_ms: 32 })
            .await
            .unwrap()
            .deleted_count,
        3
    );
    database.close().await;
}
