use xiaowei_storage::{pb::*, Database};

#[tokio::test]
async fn json_presence_prefixes_and_restart() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("storage.sqlite");
    let db = Database::open(&path).await.unwrap();
    assert_eq!(db.meta_get(MetaKey { key: "missing".into() }).await.unwrap().json, None);
    for (key, json) in [
        ("setting.a", "null"),
        ("setting.A", "false"),
        ("setting.%_", "{\"中文\":[1,true]}"),
        ("setting.other", "\"hello\""),
    ] {
        db.meta_set(MetaEntry {
            key: key.into(),
            json: json.into(),
        })
        .await
        .unwrap();
    }
    let exact = db
        .meta_list(MetaPrefix {
            prefix: "setting.%_".into(),
        })
        .await
        .unwrap();
    assert_eq!(exact.entries.len(), 1);
    assert_eq!(exact.entries[0].key, "setting.%_");
    assert!(db
        .meta_set(MetaEntry {
            key: "bad".into(),
            json: "no".into()
        })
        .await
        .is_err());
    assert!(db
        .meta_set(MetaEntry {
            key: "".into(),
            json: "1".into()
        })
        .await
        .is_err());
    assert!(!db.meta_delete(MetaKey { key: "missing".into() }).await.unwrap().deleted);
    db.close().await;
    let db = Database::open(&path).await.unwrap();
    assert_eq!(
        db.meta_get(MetaKey {
            key: "setting.a".into()
        })
        .await
        .unwrap()
        .json,
        Some("null".into())
    );
    assert!(
        db.meta_delete(MetaKey {
            key: "setting.A".into()
        })
        .await
        .unwrap()
        .deleted
    );
    assert_eq!(
        db.meta_list(MetaPrefix {
            prefix: "setting.".into()
        })
        .await
        .unwrap()
        .entries
        .len(),
        3
    );
    db.close().await;
}
