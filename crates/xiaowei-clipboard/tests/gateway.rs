use std::sync::{Arc, Mutex};
use xiaowei_clipboard::{ClipboardBackend, ClipboardData, Result, Service};
use xw_contracts::xiaowei::clipboard::{ClipboardItemRequest, ClipboardListOptions, PurgeExpiredRequest};
use xw_gateway::{CallContext, XwInvokeRegistry};

#[allow(dead_code)]
#[path = "../src/gateway_binding.rs"]
mod bindings;
use bindings::xiaowei_clipboard_clipboard_biz_service as methods;

struct Backend(Arc<Mutex<Option<ClipboardData>>>);
impl ClipboardBackend for Backend {
    fn change_count(&mut self) -> Result<i64> {
        Ok(1)
    }

    fn read(&mut self) -> Result<Option<ClipboardData>> {
        Ok(self.0.lock().unwrap().clone())
    }

    fn write(&mut self, value: &ClipboardData) -> Result<()> {
        *self.0.lock().unwrap() = Some(value.clone());
        Ok(())
    }
}

#[tokio::test]
async fn gateway_reads_original_image_bytes_and_uses_existing_service() {
    let dir = tempfile::tempdir().unwrap();
    let data = vec![0, 255, 1, 128];
    let backend = Arc::new(Mutex::new(Some(ClipboardData::Image {
        data: data.clone(),
        width: 1,
        height: 1,
    })));
    let registry = XwInvokeRegistry::new();
    let database = Arc::new(
        xiaowei_storage::Database::open(&dir.path().join("storage.sqlite"))
            .await
            .unwrap(),
    );
    registry
        .register_owner("storage", xiaowei_storage::gateway::registrations(&database), vec![])
        .unwrap();
    registry
        .register_owner(
            "clipboard-dao",
            xiaowei_storage::clipboard_dao::gateway::registrations(&Arc::new(
                xiaowei_storage::clipboard_dao::ClipboardDao::new(database.clone()),
            )),
            vec![],
        )
        .unwrap();
    let client = registry.client(CallContext::trusted("clipboard"));
    let service = Arc::new(Service::open(dir.path(), dir.path(), client, Backend(backend), || {}).unwrap());
    service.initialize().await.unwrap();
    service.poll_once().await.unwrap();

    let owner = registry
        .register_owner(
            "clipboard",
            xiaowei_clipboard::gateway::registrations(&service),
            xiaowei_clipboard::gateway::events(),
        )
        .unwrap();
    let client = registry.client(CallContext::trusted("test"));

    let rows = methods::LIST
        .call(&client, ClipboardListOptions::default())
        .await
        .unwrap();
    assert_eq!(rows.items.len(), 1);
    assert_eq!(
        methods::READ_IMAGE
            .call(&client, ClipboardItemRequest { id: rows.items[0].id })
            .await
            .unwrap()
            .png,
        data
    );

    assert!(methods::PURGE_EXPIRED
        .call(&client, PurgeExpiredRequest { retention_days: 0 })
        .await
        .is_err());
    assert_eq!(
        methods::PURGE_EXPIRED
            .call(&client, PurgeExpiredRequest { retention_days: 30 })
            .await
            .unwrap()
            .deleted_count,
        0
    );

    assert!(methods::GET
        .call(&client, ClipboardItemRequest { id: u64::MAX })
        .await
        .is_err());
    assert!(methods::LIST
        .call(
            &client,
            ClipboardListOptions {
                limit: Some(101),
                ..Default::default()
            }
        )
        .await
        .is_err());

    registry.unregister_owner(&owner);
}

#[tokio::test]
async fn selection_keeps_caller_and_stops_after_copy_or_hide_failure() {
    use bindings::{xiaowei_storage_settings_service as settings, xiaowei_system_system_service as system};
    use xw_contracts::xiaowei::{common::Empty, storage::SettingsSnapshot};
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    struct SelectionBackend(Arc<Mutex<Vec<&'static str>>>);
    impl ClipboardBackend for SelectionBackend {
        fn change_count(&mut self) -> Result<i64> {
            Ok(0)
        }
        fn read(&mut self) -> Result<Option<ClipboardData>> {
            Ok(None)
        }
        fn write(&mut self, _: &ClipboardData) -> Result<()> {
            self.0.lock().unwrap().push("copy");
            Ok(())
        }
        fn paste(&mut self) -> Result<bool> {
            self.0.lock().unwrap().push("paste");
            Ok(true)
        }
    }
    let registry = XwInvokeRegistry::new();
    let database = Arc::new(
        xiaowei_storage::Database::open(&dir.path().join("db.sqlite"))
            .await
            .unwrap(),
    );
    registry
        .register_owner(
            "dao",
            xiaowei_storage::clipboard_dao::gateway::registrations(&Arc::new(
                xiaowei_storage::clipboard_dao::ClipboardDao::new(database),
            )),
            vec![],
        )
        .unwrap();
    let client = registry.client(CallContext::trusted("selection-test"));
    let service = Arc::new(
        Service::open(
            dir.path(),
            dir.path(),
            client.clone(),
            SelectionBackend(calls.clone()),
            || {},
        )
        .unwrap(),
    );
    service.initialize().await.unwrap();
    registry
        .register_owner("clipboard", xiaowei_clipboard::gateway::registrations(&service), vec![])
        .unwrap();
    let hidden = calls.clone();
    let hide = registry
        .register_owner(
            "system",
            vec![system::HIDE_WINDOW.handler(move |_, client| {
                assert_eq!(client.context().caller(), "selection-test");
                hidden.lock().unwrap().push("hide");
                async { Ok(Empty {}) }
            })],
            vec![],
        )
        .unwrap();
    let auto_paste = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let flag = auto_paste.clone();
    registry
        .register_owner(
            "settings",
            vec![settings::GET.handler(move |_, _| {
                let enabled = flag.load(std::sync::atomic::Ordering::SeqCst);
                async move {
                    Ok(SettingsSnapshot {
                        clipboard_auto_paste: enabled,
                        ..Default::default()
                    })
                }
            })],
            vec![],
        )
        .unwrap();
    let item = service.add_text("selected".into()).await.unwrap();
    let request = ClipboardItemRequest {
        id: item.id.parse().unwrap(),
    };
    methods::SELECT.call(&client, request.clone()).await.unwrap();
    let expected = if cfg!(target_os = "macos") {
        vec!["copy", "hide", "paste"]
    } else {
        vec!["copy", "hide"]
    };
    assert_eq!(*calls.lock().unwrap(), expected);
    auto_paste.store(false, std::sync::atomic::Ordering::SeqCst);
    calls.lock().unwrap().clear();
    methods::SELECT.call(&client, request.clone()).await.unwrap();
    assert_eq!(*calls.lock().unwrap(), vec!["copy", "hide"]);
    calls.lock().unwrap().clear();
    methods::COPY.call(&client, request.clone()).await.unwrap();
    assert_eq!(*calls.lock().unwrap(), vec!["copy"]);
    calls.lock().unwrap().clear();
    assert!(methods::SELECT
        .call(&client, ClipboardItemRequest { id: 0 })
        .await
        .is_err());
    assert!(calls.lock().unwrap().is_empty());
    registry.unregister_owner(&hide);
    auto_paste.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(methods::SELECT.call(&client, request).await.is_err());
    assert_eq!(*calls.lock().unwrap(), vec!["copy"]);
}
