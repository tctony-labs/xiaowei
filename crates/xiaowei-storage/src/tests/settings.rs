use crate::{
    settings::{Apply, SettingsError, SettingsService},
    Database,
};
use std::sync::{Arc, Mutex};
use xw_contracts::xiaowei::storage::{
    update_settings_request::Change, KvEntry, KvKey, ShortcutBinding, ShortcutConfiguration, ThemeMode,
    UpdateSettingsRequest,
};

fn allow() -> Apply {
    Arc::new(|_, _| Box::pin(async { Ok(()) }))
}

#[tokio::test]
async fn old_per_key_values_keep_their_names_and_invalid_values_fall_back() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.sqlite");
    let database = Arc::new(Database::open(&path).await.unwrap());
    database
        .meta_set(KvEntry {
            key: "setting.enableOpenBookmark".into(),
            json: "false".into(),
        })
        .await
        .unwrap();
    database
        .meta_set(KvEntry {
            key: "setting.clipboardAutoPaste".into(),
            json: "true".into(),
        })
        .await
        .unwrap();
    database
        .meta_set(KvEntry {
            key: "setting.clipboardRetentionDays".into(),
            json: "5".into(),
        })
        .await
        .unwrap();
    database
        .meta_set(KvEntry {
            key: "setting.shortcuts".into(),
            json: r#"{"main":["Meta","Meta"],"clipboard":null,"quickChat":null}"#.into(),
        })
        .await
        .unwrap();

    let settings = SettingsService::new(database.clone(), "darwin".into(), allow());
    let snapshot = settings.get().await.unwrap();
    assert_eq!(snapshot.theme, ThemeMode::System as i32);
    assert!(!snapshot.include_chrome_bookmarks);
    assert!(snapshot.clipboard_auto_paste);
    assert_eq!(snapshot.clipboard_retention_days, 30);
    assert_eq!(snapshot.shortcuts.unwrap().main.unwrap().keys, ["Meta", "Space"]);

    database.close().await;
    let reopened = Arc::new(Database::open(&path).await.unwrap());
    let settings = SettingsService::new(reopened.clone(), "darwin".into(), allow());
    assert!(!settings.get().await.unwrap().include_chrome_bookmarks);
    reopened.close().await;
}

#[tokio::test]
async fn writes_one_validated_setting_and_rejects_failed_system_changes() {
    let directory = tempfile::tempdir().unwrap();
    let database = Arc::new(Database::open(&directory.path().join("settings.sqlite")).await.unwrap());
    let applied = Arc::new(Mutex::new(Vec::new()));
    let calls = applied.clone();
    let apply: Apply = Arc::new(move |previous, next| {
        let calls = calls.clone();
        Box::pin(async move {
            calls.lock().unwrap().push((previous.autostart, next.autostart));
            if next.autostart {
                Err("login item unavailable".into())
            } else {
                Ok(())
            }
        })
    });
    let settings = SettingsService::new(database.clone(), "darwin".into(), apply);

    assert!(settings
        .update(UpdateSettingsRequest {
            change: Some(Change::ClipboardRetentionDays(5)),
        })
        .await
        .is_err_and(|error| matches!(error, SettingsError::InvalidArgument(_))));
    assert!(settings
        .update(UpdateSettingsRequest {
            change: Some(Change::Theme(ThemeMode::Unspecified as i32)),
        })
        .await
        .is_err_and(|error| matches!(error, SettingsError::InvalidArgument(_))));
    assert!(settings
        .update(UpdateSettingsRequest {
            change: Some(Change::Autostart(true)),
        })
        .await
        .is_err());
    assert_eq!(applied.lock().unwrap().as_slice(), &[(false, true), (true, false)]);
    assert_eq!(settings.get().await.unwrap().autostart, false);

    let updated = settings
        .update(UpdateSettingsRequest {
            change: Some(Change::ClipboardAutoPaste(true)),
        })
        .await
        .unwrap();
    assert!(updated.clipboard_auto_paste);
    assert_eq!(
        database
            .meta_get(KvKey {
                key: "setting.clipboardAutoPaste".into(),
            })
            .await
            .unwrap()
            .json,
        Some("true".into())
    );
    assert_eq!(
        database
            .meta_get(KvKey {
                key: "setting.theme".into(),
            })
            .await
            .unwrap()
            .json,
        None
    );
    database.close().await;
}

#[tokio::test]
async fn invalid_shortcuts_are_rejected_before_system_changes() {
    let directory = tempfile::tempdir().unwrap();
    let database = Arc::new(Database::open(&directory.path().join("settings.sqlite")).await.unwrap());
    let settings = SettingsService::new(database.clone(), "darwin".into(), allow());

    for keys in [
        vec!["Meta", "Meta"],
        vec!["Meta", "Unknown"],
        vec!["KeyX", "Meta"],
        vec!["Meta", "Shift"],
    ] {
        let shortcuts = ShortcutConfiguration {
            main: Some(ShortcutBinding {
                keys: keys.into_iter().map(str::to_owned).collect(),
            }),
            clipboard: None,
            quick_chat: None,
        };
        assert!(matches!(
            settings
                .update(UpdateSettingsRequest {
                    change: Some(Change::Shortcuts(shortcuts)),
                })
                .await,
            Err(SettingsError::InvalidArgument(_))
        ));
    }
    assert_eq!(
        settings.get().await.unwrap().shortcuts.unwrap().main.unwrap().keys,
        ["Meta", "Space"]
    );

    let valid = ShortcutConfiguration {
        main: Some(ShortcutBinding {
            keys: vec!["Meta".into(), "PageUp".into()],
        }),
        clipboard: None,
        quick_chat: None,
    };
    assert!(settings
        .update(UpdateSettingsRequest {
            change: Some(Change::Shortcuts(valid)),
        })
        .await
        .is_ok());
    database.close().await;
}

#[tokio::test]
async fn legacy_shortcuts_without_quick_chat_keep_their_bindings() {
    let directory = tempfile::tempdir().unwrap();
    let database = Arc::new(Database::open(&directory.path().join("settings.sqlite")).await.unwrap());
    database
        .meta_set(KvEntry {
            key: "setting.shortcuts".into(),
            json: r#"{"main":null,"clipboard":["Meta","Shift","KeyV"]}"#.into(),
        })
        .await
        .unwrap();
    let settings = SettingsService::new(database.clone(), "darwin".into(), allow());
    let shortcuts = settings.get().await.unwrap().shortcuts.unwrap();
    assert!(shortcuts.main.is_none());
    assert_eq!(shortcuts.clipboard.unwrap().keys, ["Meta", "Shift", "KeyV"]);
    assert!(shortcuts.quick_chat.is_none());
    database.close().await;
}

#[tokio::test]
async fn failed_save_restores_system_state_and_does_not_publish() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("settings.sqlite");
    let database = Arc::new(Database::open(&path).await.unwrap());
    let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", path.display()))
        .await
        .unwrap();
    sqlx::query(
        "CREATE TRIGGER reject_autostart BEFORE INSERT ON meta \
         WHEN NEW.key = 'setting.autostart' BEGIN SELECT RAISE(FAIL, 'save rejected'); END",
    )
    .execute(&pool)
    .await
    .unwrap();
    let applied = Arc::new(Mutex::new(Vec::new()));
    let calls = applied.clone();
    let apply: Apply = Arc::new(move |previous, next| {
        let calls = calls.clone();
        Box::pin(async move {
            calls.lock().unwrap().push((previous.autostart, next.autostart));
            Ok(())
        })
    });
    let settings = SettingsService::new(database.clone(), "darwin".into(), apply);
    let published = Arc::new(Mutex::new(0));
    let events = published.clone();
    settings.set_publisher(Arc::new(move |_| *events.lock().unwrap() += 1));

    assert!(matches!(
        settings
            .update(UpdateSettingsRequest {
                change: Some(Change::Autostart(true))
            })
            .await,
        Err(SettingsError::Operation(_))
    ));
    assert_eq!(applied.lock().unwrap().as_slice(), &[(false, true), (true, false)]);
    assert_eq!(*published.lock().unwrap(), 0);
    assert!(!settings.get().await.unwrap().autostart);
    assert_eq!(
        database
            .meta_get(KvKey {
                key: "setting.autostart".into()
            })
            .await
            .unwrap()
            .json,
        None
    );
    pool.close().await;
    database.close().await;
}

#[tokio::test]
async fn concurrent_updates_keep_both_settings() {
    let directory = tempfile::tempdir().unwrap();
    let database = Arc::new(Database::open(&directory.path().join("settings.sqlite")).await.unwrap());
    let settings = SettingsService::new(database.clone(), "darwin".into(), allow());
    let (autostart, clipboard) = tokio::join!(
        settings.update(UpdateSettingsRequest {
            change: Some(Change::Autostart(true))
        }),
        settings.update(UpdateSettingsRequest {
            change: Some(Change::ClipboardAutoPaste(true))
        }),
    );
    autostart.unwrap();
    clipboard.unwrap();
    let snapshot = settings.get().await.unwrap();
    assert!(snapshot.autostart);
    assert!(snapshot.clipboard_auto_paste);
    database.close().await;
}
