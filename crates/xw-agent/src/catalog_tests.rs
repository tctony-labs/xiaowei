use super::*;

fn record(title: &str) -> AgentIndexRecord {
    let id = uuid::Uuid::now_v7().to_string();
    AgentIndexRecord {
        summary: AgentSessionSummary {
            session_id: id.clone(),
            title: title.into(),
            auto_title_enabled: true,
            created_at_ms: 1000,
            updated_at_ms: 1000,
            metadata_revision: 1,
            archive_revision: 1,
            status: AgentSessionStatus::Idle.into(),
            archived: false,
        },
        deleting: false,
    }
}

#[tokio::test]
async fn directory_is_an_independent_database_and_survives_reopen() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("sessions.sqlite");
    let catalog = SessionCatalog::open(&path).await.unwrap();
    let tables = sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .fetch_all(&catalog.pool)
        .await
        .unwrap();
    assert_eq!(
        tables.iter().map(|r| r.get::<String, _>(0)).collect::<Vec<_>>(),
        ["meta", "session"]
    );
    let entry = record("初始标题");
    catalog.register(entry.clone()).await.unwrap();
    assert!(matches!(
        catalog.register(entry.clone()).await,
        Err(AgentError::Conflict(_))
    ));
    catalog.close().await;
    let reopened = SessionCatalog::open(&path).await.unwrap();
    assert_eq!(reopened.get(&entry.summary.session_id).await.unwrap(), Some(entry));
    reopened.close().await;
    assert!(reopened.list(ListSessionsRequest::default()).await.is_err());
}

#[tokio::test]
async fn pagination_archive_cas_and_delete_cannot_resurrect_a_row() {
    let root = tempfile::tempdir().unwrap();
    let catalog = SessionCatalog::open(&root.path().join("sessions.sqlite"))
        .await
        .unwrap();
    let mut ids = Vec::new();
    for _ in 0..5 {
        let entry = record("标题");
        ids.push(entry.summary.session_id.clone());
        catalog.register(entry).await.unwrap();
    }
    ids.sort_by(|a, b| b.cmp(a));
    let mut listed = Vec::new();
    let mut continuation = String::new();
    loop {
        let page = catalog
            .list(ListSessionsRequest {
                archived: false,
                page_size: 2,
                continuation,
                query: String::new(),
            })
            .await
            .unwrap();
        listed.extend(page.sessions.into_iter().map(|s| s.session_id));
        continuation = page.continuation;
        if continuation.is_empty() {
            break;
        }
    }
    assert_eq!(listed, ids);
    let id = &ids[0];
    let mut stored = catalog.get(id).await.unwrap().unwrap().summary;
    stored.title = "手动标题".into();
    stored.auto_title_enabled = false;
    stored.metadata_revision = 2;
    catalog.update(stored.clone()).await.unwrap();
    catalog.update(stored.clone()).await.unwrap();
    let request = SetSessionArchivedRequest {
        session_id: id.clone(),
        archived: true,
        expected_archive_revision: 1,
    };
    assert_eq!(catalog.set_archived(request.clone()).await.unwrap().archive_revision, 2);
    assert!(matches!(
        catalog.set_archived(request).await,
        Err(AgentError::Conflict(_))
    ));
    let same = SetSessionArchivedRequest {
        session_id: id.clone(),
        archived: true,
        expected_archive_revision: 2,
    };
    assert_eq!(catalog.set_archived(same).await.unwrap().archive_revision, 2);
    catalog.update(stored.clone()).await.unwrap();
    let archived = catalog
        .list(ListSessionsRequest {
            archived: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(archived.sessions.len(), 1);
    assert_eq!(archived.sessions[0].archive_revision, 2);
    catalog.mark_deleting(id, None).await.unwrap();
    assert!(
        catalog
            .list(ListSessionsRequest {
                archived: true,
                ..Default::default()
            })
            .await
            .unwrap()
            .sessions
            .is_empty()
    );
    assert_eq!(catalog.list_deleting().await.unwrap().len(), 1);
    assert!(matches!(
        catalog.update(stored.clone()).await,
        Err(AgentError::Conflict(_))
    ));
    catalog.remove(id.clone()).await.unwrap();
    catalog.remove(id.clone()).await.unwrap();
    assert!(matches!(catalog.update(stored).await, Err(AgentError::Conflict(_))));
    assert!(catalog.get(id).await.unwrap().is_none());
    catalog.close().await;
}

#[tokio::test]
async fn rejects_invalid_dates_revisions_page_boundaries_and_database_format() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("sessions.sqlite");
    let catalog = SessionCatalog::open(&path).await.unwrap();
    let mut invalid_date = record("title");
    invalid_date.summary.created_at_ms = -1;
    assert!(matches!(
        catalog.register(invalid_date).await,
        Err(AgentError::InvalidArgument(_))
    ));
    let mut entry = record("title");
    entry.summary.archive_revision = u64::MAX;
    assert!(matches!(
        catalog.register(entry).await,
        Err(AgentError::InvalidArgument(_))
    ));
    for request in [
        ListSessionsRequest {
            page_size: 101,
            ..Default::default()
        },
        ListSessionsRequest {
            continuation: "bad".into(),
            ..Default::default()
        },
        ListSessionsRequest {
            archived: true,
            continuation: format!("0:1000:{}", uuid::Uuid::now_v7()),
            ..Default::default()
        },
    ] {
        assert!(matches!(
            catalog.list(request).await,
            Err(AgentError::InvalidArgument(_))
        ));
    }
    sqlx::query("PRAGMA user_version = 999")
        .execute(&catalog.pool)
        .await
        .unwrap();
    catalog.close().await;
    assert!(SessionCatalog::open(&path).await.is_err());
    let invalid = root.path().join("invalid.sqlite");
    std::fs::write(&invalid, b"not sqlite").unwrap();
    assert!(SessionCatalog::open(&invalid).await.is_err());
    assert_eq!(std::fs::read(invalid).unwrap(), b"not sqlite");
}

#[tokio::test]
async fn title_search_is_literal_and_continuation_is_bound_to_query() {
    let root = tempfile::tempdir().unwrap();
    let catalog = SessionCatalog::open(&root.path().join("sessions.sqlite"))
        .await
        .unwrap();
    for title in ["MATCH_one", "match_two", "other", "100%_literal"] {
        catalog.register(record(title)).await.unwrap();
    }
    let page = catalog
        .list(ListSessionsRequest {
            query: "match".into(),
            page_size: 1,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(page.sessions.len(), 1);
    assert!(!page.continuation.is_empty());
    assert!(
        catalog
            .list(ListSessionsRequest {
                query: "other".into(),
                continuation: page.continuation.clone(),
                ..Default::default()
            })
            .await
            .is_err()
    );
    let next = catalog
        .list(ListSessionsRequest {
            query: "match".into(),
            continuation: page.continuation,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(next.sessions.len(), 1);
    assert_ne!(next.sessions[0].session_id, page.sessions[0].session_id);
    let literal = catalog
        .list(ListSessionsRequest {
            query: "%_".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(literal.sessions.len(), 1);
    assert_eq!(literal.sessions[0].title, "100%_literal");
    catalog.close().await;
}

#[tokio::test]
async fn metadata_policy_survives_reopen_and_failed_second_key_rolls_back_both_values() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("sessions.sqlite");
    let catalog = SessionCatalog::open(&path).await.unwrap();
    assert_eq!(
        catalog.retention_policy().await.unwrap(),
        SessionRetentionPolicy {
            archive_after_days: 3,
            delete_after_days: 0,
        }
    );
    let policy = SessionRetentionPolicy {
        archive_after_days: 7,
        delete_after_days: 90,
    };
    sqlx::query("INSERT INTO meta VALUES ('other_setting', 'preserved')")
        .execute(&catalog.pool)
        .await
        .unwrap();
    catalog.set_retention_policy(&policy).await.unwrap();
    let other: String = sqlx::query_scalar("SELECT value FROM meta WHERE key = 'other_setting'")
        .fetch_one(&catalog.pool)
        .await
        .unwrap();
    assert_eq!(other, "preserved");
    sqlx::query(
        "CREATE TRIGGER fail_policy BEFORE UPDATE ON meta
         WHEN NEW.key = 'retention.delete_after_days' BEGIN SELECT RAISE(ABORT, 'failure'); END",
    )
    .execute(&catalog.pool)
    .await
    .unwrap();
    assert!(
        catalog
            .set_retention_policy(&SessionRetentionPolicy {
                archive_after_days: 1,
                delete_after_days: 0,
            })
            .await
            .is_err()
    );
    assert_eq!(catalog.retention_policy().await.unwrap(), policy);
    catalog.close().await;
    let reopened = SessionCatalog::open(&path).await.unwrap();
    assert_eq!(reopened.retention_policy().await.unwrap(), policy);
    reopened.close().await;
}

#[tokio::test]
async fn auto_archive_rechecks_activity_in_sql_after_candidate_selection() {
    let root = tempfile::tempdir().unwrap();
    let catalog = SessionCatalog::open(&root.path().join("sessions.sqlite"))
        .await
        .unwrap();
    let entry = record("old");
    catalog.register(entry.clone()).await.unwrap();
    assert_eq!(catalog.retention_candidates(false, 1000).await.unwrap().len(), 1);
    let mut active = entry.summary.clone();
    active.updated_at_ms = 1001;
    catalog.update(active).await.unwrap();
    assert!(
        catalog
            .set_archived_before(
                SetSessionArchivedRequest {
                    session_id: entry.summary.session_id.clone(),
                    archived: true,
                    expected_archive_revision: 1,
                },
                Some(1000),
                2000
            )
            .await
            .is_err()
    );
    assert!(
        !catalog
            .get(&entry.summary.session_id)
            .await
            .unwrap()
            .unwrap()
            .summary
            .archived
    );
    catalog.close().await;
}
