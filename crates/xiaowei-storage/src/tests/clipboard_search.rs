use crate::{clipboard_dao::ClipboardDao, clipboard_migrations, sql::DatabaseRollback, Database};
use std::sync::Arc;
use xw_contracts::xiaowei::{clipboard as pb, common::Empty};

async fn capture(dao: &ClipboardDao, text: &str, time: i64) -> u64 {
    dao.capture(pb::CaptureClipboardEntityRequest {
        hash: text.into(),
        kind: "text".into(),
        text: Some(text.into()),
        created_at_ms: time,
        ..Default::default()
    })
    .await
    .unwrap()
    .id
}

async fn search(dao: &ClipboardDao, query: &str) -> Vec<u64> {
    dao.list(pb::ClipboardListOptions {
        query: Some(query.into()),
        ..Default::default()
    })
    .await
    .unwrap()
    .entities
    .into_iter()
    .map(|item| item.id)
    .collect()
}

#[tokio::test]
async fn phrases_prefixes_filters_and_recency_are_applied_before_pagination() {
    let temp = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&temp.path().join("db.sqlite")).await.unwrap());
    let dao = ClipboardDao::new(db.clone());
    let phrase = capture(&dao, "Office使用指南 备注关键词", 0).await;
    assert_eq!(search(&dao, "备注关键词").await, vec![phrase]);
    assert_eq!(search(&dao, "Office使用指南").await, vec![phrase]);
    let first = capture(&dao, "企业微信 alpha middle beta", 1).await;
    let second = capture(&dao, "微信 alpha another betamax", 2).await;
    let other = capture(&dao, "alphamax beta", 3).await;
    assert_eq!(search(&dao, "微信 alpha bet").await, vec![second, first]);
    assert_eq!(search(&dao, "ALPHA bet").await, vec![second, first]);
    assert_eq!(search(&dao, "lpha").await, Vec::<u64>::new());
    for query in ["\"", "!!!", "' OR 1=1 --", "NEAR(alpha)", "alpha OR missing"] {
        assert!(search(&dao, query).await.is_empty(), "{query}");
    }
    let quoted = capture(&dao, "say \"hello\"", 4).await;
    assert_eq!(search(&dao, "\"hello\"").await, vec![quoted]);
    assert_eq!(search(&dao, " \t ").await, vec![quoted, other, second, first, phrase]);

    let category = dao
        .save_category(pb::SaveCategoryRequest {
            name: "work".into(),
            color: "#123456".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    for id in [first, second] {
        dao.set_favorite(pb::FavoriteRequest { id, favorite: true })
            .await
            .unwrap();
        dao.set_category(pb::SetCategoryRequest {
            id,
            category_id: Some(category.id),
        })
        .await
        .unwrap();
    }
    let file = dao
        .capture(pb::CaptureClipboardEntityRequest {
            hash: "file".into(),
            kind: "file".into(),
            paths: vec!["/tmp/alpha beta.txt".into()],
            created_at_ms: 5,
            ..Default::default()
        })
        .await
        .unwrap();
    let page = dao
        .list(pb::ClipboardListOptions {
            query: Some("alpha bet".into()),
            favorites_only: Some(true),
            category_id: Some(category.id),
            limit: Some(1),
            offset: Some(1),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(page.entities[0].id, first);
    let files = dao
        .list(pb::ClipboardListOptions {
            query: Some("alpha bet".into()),
            kind: Some(pb::ClipboardKind::File as i32),
            limit: Some(1),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(files.entities[0].id, file.id);
    dao.touch(pb::TouchClipboardEntityRequest {
        id: first,
        used_at_ms: 10,
    })
    .await
    .unwrap();
    assert_eq!(search(&dao, "alpha bet").await, vec![first, file.id, second]);
    db.close().await;
}

#[tokio::test]
async fn remarks_edits_merges_and_deletes_keep_the_index_in_sync() {
    let temp = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&temp.path().join("db.sqlite")).await.unwrap());
    let dao = ClipboardDao::new(db.clone());
    let source = capture(&dao, "original", 1).await;
    let target = capture(&dao, "destination", 2).await;
    dao.set_remark(pb::SetRemarkRequest {
        id: source,
        remark: "项目计划".into(),
    })
    .await
    .unwrap();
    assert_eq!(search(&dao, "original 计划").await, vec![source]);
    dao.edit_text(pb::EditClipboardEntityTextRequest {
        id: source,
        hash: "edited".into(),
        kind: "text".into(),
        text: "edited".into(),
        edited_at_ms: 3,
    })
    .await
    .unwrap();
    assert!(search(&dao, "original").await.is_empty());
    assert_eq!(search(&dao, "edited 计划").await, vec![source]);
    dao.edit_text(pb::EditClipboardEntityTextRequest {
        id: source,
        hash: "destination".into(),
        kind: "text".into(),
        text: "destination".into(),
        edited_at_ms: 4,
    })
    .await
    .unwrap();
    assert!(search(&dao, "edited").await.is_empty());
    assert_eq!(search(&dao, "destination 计划").await, vec![target]);
    dao.set_remark(pb::SetRemarkRequest {
        id: target,
        remark: String::new(),
    })
    .await
    .unwrap();
    assert!(search(&dao, "计划").await.is_empty());
    dao.delete(pb::ClipboardItemRequest { id: target }).await.unwrap();
    assert!(search(&dao, "destination").await.is_empty());
    capture(&dao, "temporary", 5).await;
    dao.clear_history_batch(Empty {}).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM clipboard_fts")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    db.close().await;
}

#[tokio::test]
async fn baseline_database_is_backfilled_and_reopen_does_not_duplicate_index() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("db.sqlite");
    let db = Database::open(&path).await.unwrap();
    let registry = clipboard_migrations::registry();
    db.rollback(DatabaseRollback {
        name: registry.migrations.last().unwrap().name.clone(),
        migrations: registry.migrations,
    })
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO clipboard_items(hash,kind,text,remark,paths,created_at,last_used_at)
        VALUES('old','text','历史记录','项目计划','[\"/tmp/Report.txt\"]',1,1)",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    db.close().await;

    for _ in 0..2 {
        let db = Arc::new(Database::open(&path).await.unwrap());
        let dao = ClipboardDao::new(db.clone());
        assert_eq!(search(&dao, "历史 计划 rep").await, vec![1]);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM clipboard_fts")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        db.close().await;
    }
}

#[tokio::test]
async fn recall_returns_entities_and_plain_snippets_through_typed_gateway() {
    use crate::gateway_binding::xiaowei_clipboard_clipboard_dao_service as methods;
    use xw_gateway::{CallContext, ErrorCode, XwInvokeRegistry};

    let temp = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&temp.path().join("db.sqlite")).await.unwrap());
    let dao = Arc::new(ClipboardDao::new(db.clone()));
    let best = capture(&dao, "needle", 1).await;
    let long_text = format!("{}needle {}", "before ".repeat(70), "after ".repeat(70));
    let long = capture(&dao, &long_text, 2).await;
    let registry = XwInvokeRegistry::new();
    registry
        .register_owner(
            "clipboard-dao",
            crate::clipboard_dao::gateway::registrations(&dao),
            vec![],
        )
        .unwrap();
    let client = registry.client(CallContext::trusted("test"));
    let hits = methods::SEARCH
        .call(
            &client,
            pb::SearchClipboardEntitiesRequest {
                query: "needle".into(),
                limit: None,
            },
        )
        .await
        .unwrap()
        .hits;
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].entity.as_ref().unwrap().id, best);
    let fragment = hits.iter().find(|hit| hit.entity.as_ref().unwrap().id == long).unwrap();
    assert_eq!(
        fragment.entity.as_ref().unwrap().text.as_deref(),
        Some(long_text.as_str())
    );
    assert!(fragment.snippet.contains("needle"));
    assert!(fragment.snippet.len() < long_text.len());
    assert!(!fragment.snippet.contains('<'));
    assert!(!fragment.snippet.contains('['));
    // The panel keeps recency order even when recall prefers the more relevant short text.
    assert_eq!(search(&dao, "needle").await, vec![long, best]);

    let bounded = methods::SEARCH
        .call(
            &client,
            pb::SearchClipboardEntitiesRequest {
                query: "needle".into(),
                limit: Some(1),
            },
        )
        .await
        .unwrap();
    assert_eq!(bounded.hits.len(), 1);
    for query in [" ", "missing", "\""] {
        let result = dao
            .search(pb::SearchClipboardEntitiesRequest {
                query: query.into(),
                limit: None,
            })
            .await
            .unwrap();
        assert!(result.hits.is_empty());
    }
    for request in [
        pb::SearchClipboardEntitiesRequest {
            query: "needle".into(),
            limit: Some(0),
        },
        pb::SearchClipboardEntitiesRequest {
            query: "needle".into(),
            limit: Some(101),
        },
        pb::SearchClipboardEntitiesRequest {
            query: "x".repeat(4097),
            limit: None,
        },
    ] {
        assert_eq!(
            methods::SEARCH.call(&client, request).await.unwrap_err().code,
            ErrorCode::InvalidArgument
        );
    }
    db.close().await;
}
