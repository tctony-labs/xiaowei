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
            xiaowei_storage::clipboard_dao_gateway::registrations(&Arc::new(
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
