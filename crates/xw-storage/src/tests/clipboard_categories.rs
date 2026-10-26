use crate::{clipboard_dao::ClipboardDao, clipboard_migrations, sql::DatabaseRollback, Database};
use proto_desktop_rs::xiaowei::desktop::clipboard as pb;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

async fn category_ids(dao: &ClipboardDao) -> Vec<u64> {
    dao.categories(())
        .await
        .unwrap()
        .items
        .into_iter()
        .map(|category| category.id)
        .collect()
}

async fn updated_at(database: &Database, id: i64) -> i64 {
    sqlx::query_scalar("SELECT updated_at FROM clipboard_categories WHERE id=?")
        .bind(id)
        .fetch_one(&database.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn categories_follow_modified_time_and_preserve_order_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("storage.sqlite");
    let database = Arc::new(Database::open(&path).await.unwrap());
    let dao = ClipboardDao::new(database.clone());
    sqlx::query(
        "INSERT INTO clipboard_categories(id,name,color) VALUES
        (1,'first','#123456'),(2,'second','#123456'),(3,'third','#123456')",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    assert_eq!(category_ids(&dao).await, vec![3, 2, 1]);

    sqlx::query("UPDATE clipboard_categories SET updated_at=(4-id)*100")
        .execute(&database.pool)
        .await
        .unwrap();
    assert_eq!(category_ids(&dao).await, vec![1, 2, 3]);

    let renamed = dao
        .save_category(pb::SaveCategoryRequest {
            id: Some(3),
            name: "renamed".into(),
            color: "#123456".into(),
        })
        .await
        .unwrap();
    assert_eq!(renamed.name, "renamed");
    assert!(updated_at(&database, 3).await > 300);
    assert_eq!(category_ids(&dao).await, vec![3, 1, 2]);

    sqlx::query("UPDATE clipboard_categories SET updated_at=id")
        .execute(&database.pool)
        .await
        .unwrap();
    let recolored = dao
        .save_category(pb::SaveCategoryRequest {
            id: Some(1),
            name: "first".into(),
            color: "#654321".into(),
        })
        .await
        .unwrap();
    assert_eq!(recolored.color, "#654321");
    assert_eq!(category_ids(&dao).await, vec![1, 3, 2]);

    let before = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    let created = dao
        .save_category(pb::SaveCategoryRequest {
            id: None,
            name: "new".into(),
            color: "#123456".into(),
        })
        .await
        .unwrap();
    let after = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    let saved = updated_at(&database, created.id as i64).await;
    assert!((before.as_millis() as i64..=after.as_millis() as i64).contains(&saved));
    assert_eq!(category_ids(&dao).await, vec![created.id, 1, 3, 2]);

    assert!(dao
        .save_category(pb::SaveCategoryRequest {
            id: Some(created.id),
            name: "invalid".into(),
            color: "invalid".into(),
        })
        .await
        .is_err());
    assert_eq!(updated_at(&database, created.id as i64).await, saved);
    assert_eq!(dao.categories(()).await.unwrap().items[0], created);
    database.close().await;

    let reopened = Arc::new(Database::open(&path).await.unwrap());
    let dao = ClipboardDao::new(reopened.clone());
    assert_eq!(category_ids(&dao).await, vec![created.id, 1, 3, 2]);
    assert_eq!(updated_at(&reopened, created.id as i64).await, saved);
    reopened.close().await;
}

#[tokio::test]
async fn category_timestamp_upgrade_preserves_existing_categories_and_assignments() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("storage.sqlite");
    let database = Database::open(&path).await.unwrap();
    let registry = clipboard_migrations::registry();
    let category_index = registry
        .migrations
        .iter()
        .position(|migration| migration.name == "20261025000000_clipboard_category_updated_at")
        .unwrap();
    for migration in registry.migrations[category_index..].iter().rev() {
        database
            .rollback(DatabaseRollback {
                name: migration.name.clone(),
                migrations: registry.migrations.clone(),
            })
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO clipboard_categories(id,name,color) VALUES(7,'existing','#123456')")
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO clipboard_items(hash,kind,text,created_at,last_used_at,category_id)
        VALUES('existing','text','keep',1,2,7)",
    )
    .execute(&database.pool)
    .await
    .unwrap();
    database.close().await;

    for _ in 0..2 {
        let reopened = Arc::new(Database::open(&path).await.unwrap());
        let dao = ClipboardDao::new(reopened.clone());
        let category = dao.categories(()).await.unwrap().items.remove(0);
        assert_eq!((category.id, category.name.as_str()), (7, "existing"));
        assert_eq!(category.color, "#123456");
        assert_eq!(updated_at(&reopened, 7).await, 0);
        let assignment: i64 =
            sqlx::query_scalar("SELECT category_id FROM clipboard_items WHERE hash='existing'")
                .fetch_one(&reopened.pool)
                .await
                .unwrap();
        assert_eq!(assignment, 7);
        reopened.close().await;
    }
}
