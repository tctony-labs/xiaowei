use std::sync::{Arc, Mutex};
use xiaowei_clipboard::{ClipboardBackend, ClipboardData, ListOptions, Result, Service, Store};

fn options() -> ListOptions {
    ListOptions {
        query: String::new(),
        favorites_only: false,
        kind: None,
        category_id: None,
        limit: 50,
        offset: 0,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn dedup_preserves_identity_favorites_and_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let id;
    {
        let store = open_store(dir.path()).await.unwrap();
        let data = ClipboardData::Text("你好 world".into());
        let first = store.capture(&data).await.unwrap();
        id = first.id.parse().unwrap();
        store.set_favorite(id, true).await.unwrap();
        let again = store.capture(&data).await.unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(again.use_count, 1);
        assert!(again.favorite);
    }
    let store = open_store(dir.path()).await.unwrap();
    assert!(store.get(id).await.unwrap().unwrap().favorite);
    assert_eq!(store.list(&options()).await.unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn full_content_hashes_do_not_confuse_same_prefixes_or_comma_paths() {
    let a = ClipboardData::Text(format!("{}a", "中".repeat(4000)));
    let b = ClipboardData::Text(format!("{}b", "中".repeat(4000)));
    assert_ne!(a.hash(), b.hash());
    assert_ne!(
        ClipboardData::Files(vec!["/a,b".into(), "/c".into()]).hash(),
        ClipboardData::Files(vec!["/a".into(), "b,/c".into()]).hash()
    );
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path()).await.unwrap();
    let item = store.capture(&a).await.unwrap();
    assert_eq!(item.kind, "largeText");
    assert_eq!(item.text.unwrap().chars().count(), 500);
    assert_eq!(store.data(item.id.parse().unwrap()).await.unwrap(), a);
}

#[tokio::test(flavor = "multi_thread")]
async fn images_and_file_paths_persist_without_loading_image_bytes_in_lists() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path()).await.unwrap();
    let image = ClipboardData::Image {
        data: vec![1, 2, 3],
        width: 1,
        height: 1,
    };
    let id = store.capture(&image).await.unwrap().id.parse().unwrap();
    assert_eq!(store.data(id).await.unwrap(), image);
    assert_eq!(store.get(id).await.unwrap().unwrap().width, Some(1));
    let files = ClipboardData::Files(vec!["/tmp/a,b.txt".into(), "/tmp/中文.txt".into()]);
    let item = store.capture(&files).await.unwrap();
    assert_eq!(item.paths.len(), 2);
    assert_eq!(store.data(item.id.parse().unwrap()).await.unwrap(), files);
    assert!(store.delete(id).await.unwrap());
    assert!(store.data(id).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn literal_search_pagination_and_clear_protect_favorites() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path()).await.unwrap();
    assert!(store.capture(&ClipboardData::Text(" \n".into())).await.is_err());
    let first = store.capture(&ClipboardData::Text("100%_中文".into())).await.unwrap();
    store.capture(&ClipboardData::Text("other".into())).await.unwrap();
    store.set_favorite(first.id.parse().unwrap(), true).await.unwrap();
    let mut filter = options();
    filter.query = "%_中".into();
    assert_eq!(store.list(&filter).await.unwrap()[0].id, first.id);
    filter.query = "' OR 1=1 --".into();
    assert!(store.list(&filter).await.unwrap().is_empty());
    filter = options();
    filter.limit = 1;
    let newest = store.list(&filter).await.unwrap()[0].id.clone();
    filter.offset = 1;
    assert_ne!(store.list(&filter).await.unwrap()[0].id, newest);
    assert_eq!(store.clear_history().await.unwrap(), 1);
    assert!(store.get(first.id.parse().unwrap()).await.unwrap().unwrap().favorite);
    filter.limit = 101;
    assert!(store.list(&filter).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn ordinary_purge_protects_favorites_remarks_and_categories_and_releases_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path()).await.unwrap();
    let ordinary = store.capture(&ClipboardData::Text("ordinary".into())).await.unwrap();
    let image = store
        .capture(&ClipboardData::Image {
            data: vec![1, 2, 3],
            width: 1,
            height: 1,
        })
        .await
        .unwrap();
    let image_path = image.image_path.unwrap();
    let favorite = store.capture(&ClipboardData::Text("favorite".into())).await.unwrap();
    let remarked = store.capture(&ClipboardData::Text("remarked".into())).await.unwrap();
    let categorized = store.capture(&ClipboardData::Text("categorized".into())).await.unwrap();
    let category = store.save_category(None, "work", "#112233").await.unwrap();
    store.set_favorite(favorite.id.parse().unwrap(), true).await.unwrap();
    store.set_remark(remarked.id.parse().unwrap(), "keep").await.unwrap();
    store
        .set_category(categorized.id.parse().unwrap(), Some(category.id.parse().unwrap()))
        .await
        .unwrap();

    assert_eq!(store.purge_ordinary_before(0).await.unwrap(), 0);
    assert_eq!(store.purge_ordinary_before(i64::MAX).await.unwrap(), 2);
    assert!(store.get(ordinary.id.parse().unwrap()).await.unwrap().is_none());
    assert!(!std::path::Path::new(&image_path).exists());
    for item in [favorite, remarked, categorized] {
        assert!(store.get(item.id.parse().unwrap()).await.unwrap().is_some());
    }
    assert_eq!(store.purge_ordinary_before(i64::MAX).await.unwrap(), 0);
}

#[derive(Default)]
struct FakeState {
    count: i64,
    data: Option<ClipboardData>,
    fail_write: bool,
    fail_read: bool,
    change_during_read: bool,
}
#[derive(Clone, Default)]
struct Fake(Arc<Mutex<FakeState>>);
impl Fake {
    fn set(&self, text: &str) {
        let mut state = self.0.lock().unwrap();
        state.count += 1;
        state.data = Some(ClipboardData::Text(text.into()));
    }
}
impl ClipboardBackend for Fake {
    fn change_count(&mut self) -> Result<i64> {
        Ok(self.0.lock().unwrap().count)
    }
    fn read(&mut self) -> Result<Option<ClipboardData>> {
        let mut state = self.0.lock().unwrap();
        if state.fail_read {
            return Err("simulated read error".into());
        }
        if state.change_during_read {
            state.count += 1;
        }
        Ok(state.data.clone())
    }
    fn write(&mut self, data: &ClipboardData) -> Result<()> {
        let mut state = self.0.lock().unwrap();
        if state.fail_write {
            return Err("simulated write error".into());
        }
        state.count += 1;
        state.data = Some(data.clone());
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn polling_deduplicates_and_copy_does_not_count_itself_twice() {
    let dir = tempfile::tempdir().unwrap();
    let clipboard = Fake::default();
    let service = open_service(dir.path(), clipboard.clone(), || {}).await.unwrap();
    clipboard.set("one");
    assert!(service.poll_once().await.unwrap());
    let item = service.list(&options()).await.unwrap().remove(0);
    let id = item.id.parse().unwrap();
    assert!(!service.poll_once().await.unwrap());
    clipboard.set("one");
    assert!(!service.poll_once().await.unwrap());
    clipboard.set("two");
    assert!(service.poll_once().await.unwrap());
    service.copy(id).await.unwrap();
    assert_eq!(
        clipboard.0.lock().unwrap().data,
        Some(ClipboardData::Text("one".into()))
    );
    assert!(!service.poll_once().await.unwrap());
    assert_eq!(service.get(id).await.unwrap().unwrap().use_count, 1);
    clipboard.0.lock().unwrap().fail_write = true;
    assert!(service.copy(id).await.is_err());
    assert_eq!(service.get(id).await.unwrap().unwrap().use_count, 1);
    assert_eq!(service.list(&options()).await.unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn capture_retries_failures_and_inconsistent_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let clipboard = Fake::default();
    clipboard.set("retry");
    let service = open_service(dir.path(), clipboard.clone(), || {}).await.unwrap();
    clipboard.0.lock().unwrap().fail_read = true;
    assert!(service.poll_once().await.is_err());
    {
        let mut state = clipboard.0.lock().unwrap();
        state.fail_read = false;
        state.change_during_read = true;
    }
    assert!(!service.poll_once().await.unwrap());
    assert!(service.list(&options()).await.unwrap().is_empty());
    clipboard.0.lock().unwrap().change_during_read = false;
    assert!(service.poll_once().await.unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_history_save_retries_the_same_clipboard_change() {
    let dir = tempfile::tempdir().unwrap();
    let clipboard = Fake::default();
    let text = "x".repeat(10_000);
    clipboard.set(&text);
    let service = open_service(dir.path(), clipboard, || {}).await.unwrap();
    let path = dir
        .path()
        .join("large_text")
        .join(ClipboardData::Text(text.clone()).hash());
    std::fs::create_dir(&path).unwrap();

    assert!(service.poll_once().await.is_err());
    assert!(service.list(&options()).await.unwrap().is_empty());

    std::fs::remove_dir(&path).unwrap();
    assert!(service.poll_once().await.unwrap());
    assert!(!service.poll_once().await.unwrap());
    assert_eq!(service.list(&options()).await.unwrap().len(), 1);
    assert_eq!(std::fs::read_to_string(path).unwrap(), text);
}

#[tokio::test(flavor = "multi_thread")]
async fn monitoring_is_idempotent_and_stops_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let clipboard = Fake::default();
    clipboard.set("worker");
    let (tx, rx) = std::sync::mpsc::channel();
    let service = open_service(dir.path(), clipboard.clone(), move || {
        let _ = tx.send(());
    })
    .await
    .unwrap();
    service.start().await.unwrap();
    service.start().await.unwrap();
    rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
    service.stop().await.unwrap();
    service.stop().await.unwrap();
    clipboard.set("after-stop");
    assert!(rx.recv_timeout(std::time::Duration::from_millis(600)).is_err());
    assert_eq!(service.list(&options()).await.unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn kind_filter_runs_before_pagination_and_composes_with_favorites() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path()).await.unwrap();
    let file = store
        .capture(&ClipboardData::Files(vec!["/tmp/a.pdf".into()]))
        .await
        .unwrap();
    store
        .capture(&ClipboardData::Text("more recent text".into()))
        .await
        .unwrap();
    let mut filter = options();
    filter.kind = Some("file".into());
    filter.limit = 1;
    assert_eq!(store.list(&filter).await.unwrap()[0].id, file.id);
    filter.favorites_only = true;
    assert!(store.list(&filter).await.unwrap().is_empty());
    store.set_favorite(file.id.parse().unwrap(), true).await.unwrap();
    assert_eq!(store.list(&filter).await.unwrap()[0].id, file.id);
    filter.query = "a.pdf".into();
    assert_eq!(store.list(&filter).await.unwrap().len(), 1);
    filter.kind = Some("image".into());
    assert!(store.list(&filter).await.unwrap().is_empty());
    filter.kind = Some("invalid".into());
    assert!(store.list(&filter).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn metadata_categories_editing_and_merge_persist() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path()).await.unwrap();
    let source = store.capture(&ClipboardData::Text("source".into())).await.unwrap();
    let target = store.capture(&ClipboardData::Text("target".into())).await.unwrap();
    let source_id = source.id.parse().unwrap();
    let target_id = target.id.parse().unwrap();
    let category = store.save_category(None, "工作", "#F5222D").await.unwrap();
    let category_id = category.id.parse().unwrap();
    store.set_remark(source_id, "来源备注").await.unwrap();
    store.set_remark(target_id, "目标备注").await.unwrap();
    store.set_favorite(source_id, true).await.unwrap();
    store.set_category(source_id, Some(category_id)).await.unwrap();
    let mut filter = options();
    filter.category_id = Some(category.id.clone());
    filter.query = "来源备注".into();
    assert_eq!(store.list(&filter).await.unwrap()[0].id, source.id);
    let edited = store.edit_text(source_id, "a".repeat(12000)).await.unwrap();
    assert_eq!(edited.kind, "largeText");
    assert_eq!(edited.remark.as_deref(), Some("来源备注"));
    assert_eq!(
        store.data(source_id).await.unwrap(),
        ClipboardData::Text("a".repeat(12000))
    );
    let merged = store.edit_text(source_id, "target".into()).await.unwrap();
    assert_eq!(merged.id, target.id);
    assert!(merged.favorite);
    assert_eq!(merged.remark.as_deref(), Some("来源备注;目标备注"));
    assert_eq!(merged.category_id, Some(category.id.clone()));
    assert!(store.get(source_id).await.unwrap().is_none());
    assert!(store.edit_text(target_id, "  ".into()).await.is_err());
    assert_eq!(
        store.data(target_id).await.unwrap(),
        ClipboardData::Text("target".into())
    );
    store.save_category(Some(category_id), "项目", "#1677FF").await.unwrap();
    drop(store);
    let store = open_store(dir.path()).await.unwrap();
    assert_eq!(store.categories().await.unwrap()[0].name, "项目");
    assert_eq!(store.get(target_id).await.unwrap().unwrap().remark, merged.remark);
    store.delete_category(category_id).await.unwrap();
    let retained = store.get(target_id).await.unwrap().unwrap();
    assert!(retained.category_id.is_none());
    assert!(retained.favorite);
    assert!(store.set_category(target_id, Some(category_id)).await.is_err());
    store.set_remark(target_id, "").await.unwrap();
    assert!(store.get(target_id).await.unwrap().unwrap().remark.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn image_files_survive_reopen_and_follow_record_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let image = ClipboardData::Image {
        data: vec![1, 2, 3],
        width: 1,
        height: 1,
    };
    let store = open_store(dir.path()).await.unwrap();
    let first = store.capture(&image).await.unwrap();
    let path = first.image_path.unwrap();
    assert!(std::path::Path::new(&path).starts_with(dir.path().join("images")));
    assert_eq!(std::fs::read(&path).unwrap(), vec![1, 2, 3]);
    let id = first.id.parse().unwrap();
    store.set_favorite(id, true).await.unwrap();
    drop(store);
    let store = open_store(dir.path()).await.unwrap();
    assert_eq!(
        store.get(id).await.unwrap().unwrap().image_path.as_deref(),
        Some(path.as_str())
    );
    assert_eq!(store.data(id).await.unwrap(), image);
    assert_eq!(store.capture(&image).await.unwrap().id, first.id);
    assert_eq!(store.clear_history().await.unwrap(), 0);
    assert!(std::path::Path::new(&path).exists());
    store.set_favorite(id, false).await.unwrap();
    assert_eq!(store.clear_history().await.unwrap(), 1);
    assert!(!std::path::Path::new(&path).exists());
    let item = store.capture(&image).await.unwrap();
    store.delete(item.id.parse().unwrap()).await.unwrap();
    assert!(!std::path::Path::new(&path).exists());
}

async fn client(directory: &std::path::Path) -> xw_gateway::invoke::Client {
    let db = Arc::new(
        xiaowei_storage::Database::open(&directory.join("storage.sqlite"))
            .await
            .unwrap(),
    );
    let registry = xw_gateway::XwInvokeRegistry::new();
    registry
        .register_owner("storage", xiaowei_storage::gateway::registrations(&db), vec![])
        .unwrap();
    registry
        .register_owner(
            "clipboard-dao",
            xiaowei_storage::clipboard_dao_gateway::registrations(&Arc::new(
                xiaowei_storage::clipboard_dao::ClipboardDao::new(db.clone()),
            )),
            vec![],
        )
        .unwrap();
    registry.client(xw_gateway::CallContext::trusted("clipboard-tests"))
}

async fn open_store(directory: &std::path::Path) -> Result<Store> {
    let store = Store::open(directory, client(directory).await)?;
    store.initialize().await?;
    Ok(store)
}

async fn open_service(
    directory: &std::path::Path,
    backend: impl ClipboardBackend,
    on_change: impl Fn() + Send + Sync + 'static,
) -> Result<Service> {
    let service = Service::open(directory, client(directory).await, backend, on_change)?;
    service.initialize().await?;
    Ok(service)
}

#[tokio::test]
async fn long_text_attachments_follow_edits_merges_and_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path()).await.unwrap();
    let text = format!("{}tail-only-keyword", "中".repeat(4000));
    let first = store.capture(&ClipboardData::Text(text.clone())).await.unwrap();
    let id = first.id.parse().unwrap();
    let path = first.text_path.clone().unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    assert_eq!(first.text.unwrap().chars().count(), 500);
    let mut query = options();
    query.query = "tail-only-keyword".into();
    assert!(store.list(&query).await.unwrap().is_empty());
    store.edit_text(id, "short".into()).await.unwrap();
    assert!(!std::path::Path::new(&path).exists());
    let restored = store.edit_text(id, text.clone()).await.unwrap();
    assert_eq!(restored.kind, "largeText");
    assert_eq!(store.data(id).await.unwrap(), ClipboardData::Text(text.clone()));
    let second_text = "new long text".repeat(1000);
    let second = store.capture(&ClipboardData::Text(second_text.clone())).await.unwrap();
    store.set_favorite(id, true).await.unwrap();
    let merged = store.edit_text(id, second_text).await.unwrap();
    assert_eq!(merged.id, second.id);
    assert!(merged.favorite);
    assert!(!std::path::Path::new(&path).exists());
    let merged_path = merged.text_path.unwrap();
    assert!(std::path::Path::new(&merged_path).exists());
    store.delete(merged.id.parse().unwrap()).await.unwrap();
    assert!(!std::path::Path::new(&merged_path).exists());
}

#[tokio::test]
async fn attachment_write_failure_does_not_change_record_and_missing_file_is_explicit() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(dir.path()).await.unwrap();
    let initial = store.capture(&ClipboardData::Text("short".into())).await.unwrap();
    let id = initial.id.parse().unwrap();
    let text_dir = dir.path().join("large_text");
    std::fs::remove_dir(&text_dir).unwrap();
    std::fs::write(&text_dir, b"blocks directory").unwrap();
    assert!(store.edit_text(id, "long".repeat(4000)).await.is_err());
    assert_eq!(store.data(id).await.unwrap(), ClipboardData::Text("short".into()));
    std::fs::remove_file(&text_dir).unwrap();
    std::fs::create_dir(&text_dir).unwrap();
    let long = store.edit_text(id, "long".repeat(4000)).await.unwrap();
    std::fs::remove_file(long.text_path.unwrap()).unwrap();
    assert!(store.data(id).await.is_err());
    assert!(store.get(id).await.unwrap().is_some());
}
