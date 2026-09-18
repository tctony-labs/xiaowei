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

#[test]
fn dedup_preserves_identity_favorites_and_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let id;
    {
        let store = Store::open(dir.path()).unwrap();
        let data = ClipboardData::Text("你好 world".into());
        let first = store.capture(&data).unwrap();
        id = first.id.parse().unwrap();
        store.set_favorite(id, true).unwrap();
        let again = store.capture(&data).unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(again.use_count, 1);
        assert!(again.favorite);
    }
    let store = Store::open(dir.path()).unwrap();
    assert!(store.get(id).unwrap().unwrap().favorite);
    assert_eq!(store.list(&options()).unwrap().len(), 1);
}

#[test]
fn full_content_hashes_do_not_confuse_same_prefixes_or_comma_paths() {
    let a = ClipboardData::Text(format!("{}a", "中".repeat(4000)));
    let b = ClipboardData::Text(format!("{}b", "中".repeat(4000)));
    assert_ne!(a.hash(), b.hash());
    assert_ne!(
        ClipboardData::Files(vec!["/a,b".into(), "/c".into()]).hash(),
        ClipboardData::Files(vec!["/a".into(), "b,/c".into()]).hash()
    );
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let item = store.capture(&a).unwrap();
    assert_eq!(item.kind, "largeText");
    assert_eq!(item.text.unwrap().chars().count(), 500);
    assert_eq!(store.data(item.id.parse().unwrap()).unwrap(), a);
}

#[test]
fn images_and_file_paths_persist_without_loading_image_bytes_in_lists() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let image = ClipboardData::Image {
        data: vec![1, 2, 3],
        width: 1,
        height: 1,
    };
    let id = store.capture(&image).unwrap().id.parse().unwrap();
    assert_eq!(store.data(id).unwrap(), image);
    assert_eq!(store.get(id).unwrap().unwrap().width, Some(1));
    let files = ClipboardData::Files(vec!["/tmp/a,b.txt".into(), "/tmp/中文.txt".into()]);
    let item = store.capture(&files).unwrap();
    assert_eq!(item.paths.len(), 2);
    assert_eq!(store.data(item.id.parse().unwrap()).unwrap(), files);
    assert!(store.delete(id).unwrap());
    assert!(store.data(id).is_err());
}

#[test]
fn literal_search_pagination_and_clear_protect_favorites() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    assert!(store.capture(&ClipboardData::Text(" \n".into())).is_err());
    let first = store.capture(&ClipboardData::Text("100%_中文".into())).unwrap();
    store.capture(&ClipboardData::Text("other".into())).unwrap();
    store.set_favorite(first.id.parse().unwrap(), true).unwrap();
    let mut filter = options();
    filter.query = "%_中".into();
    assert_eq!(store.list(&filter).unwrap()[0].id, first.id);
    filter.query = "' OR 1=1 --".into();
    assert!(store.list(&filter).unwrap().is_empty());
    filter = options();
    filter.limit = 1;
    let newest = store.list(&filter).unwrap()[0].id.clone();
    filter.offset = 1;
    assert_ne!(store.list(&filter).unwrap()[0].id, newest);
    assert_eq!(store.clear_history().unwrap(), 1);
    assert!(store.get(first.id.parse().unwrap()).unwrap().unwrap().favorite);
    filter.limit = 101;
    assert!(store.list(&filter).is_err());
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

#[test]
fn polling_deduplicates_and_copy_does_not_count_itself_twice() {
    let dir = tempfile::tempdir().unwrap();
    let clipboard = Fake::default();
    let service = Service::open(dir.path(), clipboard.clone(), || {}).unwrap();
    clipboard.set("one");
    assert!(service.poll_once().unwrap());
    let item = service.list(&options()).unwrap().remove(0);
    let id = item.id.parse().unwrap();
    assert!(!service.poll_once().unwrap());
    clipboard.set("one");
    assert!(!service.poll_once().unwrap());
    clipboard.set("two");
    assert!(service.poll_once().unwrap());
    service.copy(id).unwrap();
    assert_eq!(
        clipboard.0.lock().unwrap().data,
        Some(ClipboardData::Text("one".into()))
    );
    assert!(!service.poll_once().unwrap());
    assert_eq!(service.get(id).unwrap().unwrap().use_count, 1);
    clipboard.0.lock().unwrap().fail_write = true;
    assert!(service.copy(id).is_err());
    assert_eq!(service.get(id).unwrap().unwrap().use_count, 1);
    assert_eq!(service.list(&options()).unwrap().len(), 2);
}

#[test]
fn capture_retries_failures_and_inconsistent_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let clipboard = Fake::default();
    clipboard.set("retry");
    let service = Service::open(dir.path(), clipboard.clone(), || {}).unwrap();
    clipboard.0.lock().unwrap().fail_read = true;
    assert!(service.poll_once().is_err());
    {
        let mut state = clipboard.0.lock().unwrap();
        state.fail_read = false;
        state.change_during_read = true;
    }
    assert!(!service.poll_once().unwrap());
    assert!(service.list(&options()).unwrap().is_empty());
    clipboard.0.lock().unwrap().change_during_read = false;
    assert!(service.poll_once().unwrap());
}

#[test]
fn monitoring_is_idempotent_and_stops_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let clipboard = Fake::default();
    clipboard.set("worker");
    let (tx, rx) = std::sync::mpsc::channel();
    let service = Service::open(dir.path(), clipboard.clone(), move || {
        let _ = tx.send(());
    })
    .unwrap();
    service.start().unwrap();
    service.start().unwrap();
    rx.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
    service.stop().unwrap();
    service.stop().unwrap();
    clipboard.set("after-stop");
    assert!(rx.recv_timeout(std::time::Duration::from_millis(600)).is_err());
    assert_eq!(service.list(&options()).unwrap().len(), 1);
}

#[test]
fn kind_filter_runs_before_pagination_and_composes_with_favorites() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let file = store.capture(&ClipboardData::Files(vec!["/tmp/a.pdf".into()])).unwrap();
    store.capture(&ClipboardData::Text("more recent text".into())).unwrap();
    let mut filter = options();
    filter.kind = Some("file".into());
    filter.limit = 1;
    assert_eq!(store.list(&filter).unwrap()[0].id, file.id);
    filter.favorites_only = true;
    assert!(store.list(&filter).unwrap().is_empty());
    store.set_favorite(file.id.parse().unwrap(), true).unwrap();
    assert_eq!(store.list(&filter).unwrap()[0].id, file.id);
    filter.query = "a.pdf".into();
    assert_eq!(store.list(&filter).unwrap().len(), 1);
    filter.kind = Some("image".into());
    assert!(store.list(&filter).unwrap().is_empty());
    filter.kind = Some("invalid".into());
    assert!(store.list(&filter).is_err());
}

#[test]
fn metadata_categories_editing_and_merge_persist() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let source = store.capture(&ClipboardData::Text("source".into())).unwrap();
    let target = store.capture(&ClipboardData::Text("target".into())).unwrap();
    let source_id = source.id.parse().unwrap();
    let target_id = target.id.parse().unwrap();
    let category = store.save_category(None, "工作", "#F5222D").unwrap();
    let category_id = category.id.parse().unwrap();
    store.set_remark(source_id, "来源备注").unwrap();
    store.set_remark(target_id, "目标备注").unwrap();
    store.set_favorite(source_id, true).unwrap();
    store.set_category(source_id, Some(category_id)).unwrap();
    let mut filter = options();
    filter.category_id = Some(category.id.clone());
    filter.query = "来源备注".into();
    assert_eq!(store.list(&filter).unwrap()[0].id, source.id);
    let edited = store.edit_text(source_id, "a".repeat(12000)).unwrap();
    assert_eq!(edited.kind, "largeText");
    assert_eq!(edited.remark.as_deref(), Some("来源备注"));
    assert_eq!(store.data(source_id).unwrap(), ClipboardData::Text("a".repeat(12000)));
    let merged = store.edit_text(source_id, "target".into()).unwrap();
    assert_eq!(merged.id, target.id);
    assert!(merged.favorite);
    assert_eq!(merged.remark.as_deref(), Some("来源备注;目标备注"));
    assert_eq!(merged.category_id, Some(category.id.clone()));
    assert!(store.get(source_id).unwrap().is_none());
    assert!(store.edit_text(target_id, "  ".into()).is_err());
    assert_eq!(store.data(target_id).unwrap(), ClipboardData::Text("target".into()));
    store.save_category(Some(category_id), "项目", "#1677FF").unwrap();
    drop(store);
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(store.categories().unwrap()[0].name, "项目");
    assert_eq!(store.get(target_id).unwrap().unwrap().remark, merged.remark);
    store.delete_category(category_id).unwrap();
    let retained = store.get(target_id).unwrap().unwrap();
    assert!(retained.category_id.is_none());
    assert!(retained.favorite);
    assert!(store.set_category(target_id, Some(category_id)).is_err());
    store.set_remark(target_id, "").unwrap();
    assert!(store.get(target_id).unwrap().unwrap().remark.is_none());
}

#[test]
fn upgrades_v1_database_without_losing_history() {
    let dir = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(dir.path().join("history.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        text TEXT,png BLOB,paths TEXT NOT NULL DEFAULT '[]',width INTEGER,height INTEGER,
        created_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL,use_count INTEGER NOT NULL DEFAULT 0,
        favorite INTEGER NOT NULL DEFAULT 0);
        INSERT INTO items(hash,kind,text,created_at,last_used_at,favorite) VALUES('old','text','保留',1,1,1);
        PRAGMA user_version=1;",
    )
    .unwrap();
    drop(db);
    let store = Store::open(dir.path()).unwrap();
    let old = store.get(1).unwrap().unwrap();
    assert_eq!(old.text.as_deref(), Some("保留"));
    assert!(old.favorite);
    assert!(old.remark.is_none());
    let category = store.save_category(None, "迁移后", "#52C41A").unwrap();
    store.set_category(1, Some(category.id.parse().unwrap())).unwrap();
    store.set_remark(1, "已迁移").unwrap();
    assert_eq!(store.get(1).unwrap().unwrap().remark.as_deref(), Some("已迁移"));
}

#[test]
fn image_files_survive_reopen_and_follow_record_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let image = ClipboardData::Image {
        data: vec![1, 2, 3],
        width: 1,
        height: 1,
    };
    let store = Store::open(dir.path()).unwrap();
    let first = store.capture(&image).unwrap();
    let path = first.image_path.unwrap();
    assert!(std::path::Path::new(&path).starts_with(dir.path().join("images")));
    assert_eq!(std::fs::read(&path).unwrap(), vec![1, 2, 3]);
    let id = first.id.parse().unwrap();
    store.set_favorite(id, true).unwrap();
    drop(store);
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(
        store.get(id).unwrap().unwrap().image_path.as_deref(),
        Some(path.as_str())
    );
    assert_eq!(store.data(id).unwrap(), image);
    assert_eq!(store.capture(&image).unwrap().id, first.id);
    assert_eq!(store.clear_history().unwrap(), 0);
    assert!(std::path::Path::new(&path).exists());
    store.set_favorite(id, false).unwrap();
    assert_eq!(store.clear_history().unwrap(), 1);
    assert!(!std::path::Path::new(&path).exists());
    let item = store.capture(&image).unwrap();
    store.delete(item.id.parse().unwrap()).unwrap();
    assert!(!std::path::Path::new(&path).exists());
}

#[test]
fn blob_migration_preserves_bytes_metadata_and_retries_after_failure() {
    let dir = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(dir.path().join("history.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE items (
        id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        text TEXT,png BLOB,paths TEXT NOT NULL DEFAULT '[]',width INTEGER,height INTEGER,
        created_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL,use_count INTEGER NOT NULL DEFAULT 0,
        favorite INTEGER NOT NULL DEFAULT 0,remark TEXT,category_id INTEGER);
        CREATE TABLE categories(id INTEGER PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL);
        INSERT INTO items(id,hash,kind,png,width,height,created_at,last_used_at,favorite,remark)
        VALUES(1,'abc','image',X'010203',1,1,123,456,1,'keep');
        PRAGMA user_version=2;",
    )
    .unwrap();
    let path = dir.path().join("images/abc.png");
    std::fs::create_dir_all(&path).unwrap(); // Force a filesystem failure without relying on permissions.
    assert!(Store::open(dir.path()).is_err());
    assert_eq!(
        db.query_row("SELECT png FROM items", [], |row| row.get::<_, Vec<u8>>(0))
            .unwrap(),
        vec![1, 2, 3]
    );
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
            .unwrap(),
        2
    );
    std::fs::remove_dir(&path).unwrap();
    let store = Store::open(dir.path()).unwrap();
    let item = store.get(1).unwrap().unwrap();
    assert!(item.favorite);
    assert_eq!(item.remark.as_deref(), Some("keep"));
    assert_eq!(item.created_at, 123);
    assert_eq!(item.last_used_at, 456);
    assert_eq!(std::fs::read(&path).unwrap(), vec![1, 2, 3]);
    assert!(db
        .query_row("SELECT png FROM items", [], |row| row.get::<_, Vec<u8>>(0))
        .is_err());
    drop(store);
    assert_eq!(
        Store::open(dir.path()).unwrap().get(1).unwrap().unwrap().image_path,
        item.image_path
    );
}
