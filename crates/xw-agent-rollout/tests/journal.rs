use std::{
    fs::{self, OpenOptions},
    io::Write,
};

use xw_agent_rollout::{RolloutError, RolloutStore};
use xw_agent_types::*;

fn entries() -> Vec<JournalEntry> {
    decode_history(include_str!("fixtures/basic.jsonl")).unwrap()
}

#[test]
fn invalid_initial_meta_removes_the_partial_header_and_allows_creation_retry() {
    let directory = tempfile::tempdir().unwrap();
    let store = RolloutStore::new(directory.path());
    let fixture = entries();
    let EntryPayload::Meta(meta) = &fixture[1].payload else {
        panic!("missing meta");
    };
    let mut invalid = meta.clone();
    invalid.model_ref = None;
    let id = fixture[0].session_id;
    let created_at_ms = fixture[0].timestamp_ms;
    assert!(store.create(id, created_at_ms, invalid).is_err());
    assert!(store.session_ids().unwrap().is_empty());

    let journal = store.create(id, created_at_ms, meta.clone()).unwrap();
    assert!(matches!(journal.entries()[0].payload, EntryPayload::SessionHeader));
    assert_eq!(journal.entries()[1].payload, EntryPayload::Meta(meta.clone()));
}

#[test]
fn registered_files_use_creation_month_in_utc_without_scanning() {
    let directory = tempfile::tempdir().unwrap();
    let store = RolloutStore::new(directory.path());
    let fixture = entries();
    let id = fixture[0].session_id;
    let EntryPayload::Meta(meta) = fixture[1].payload.clone() else {
        panic!("missing meta");
    };
    // This date differs from the UUID's timestamp and falls on a UTC month boundary.
    let created_at_ms = 1_735_689_600_000;
    let journal = store.create(id, created_at_ms, meta.clone()).unwrap();
    let path = directory.path().join("sessions/2025/01").join(format!("{id}.jsonl"));
    assert_eq!(journal.path(), path);
    drop(journal);

    assert!(store.open_registered(id, created_at_ms - 1).is_err());
    let (journal, repair) = store.open_registered(id, created_at_ms).unwrap();
    assert_eq!(journal.entries().len(), 2);
    assert_eq!(repair.discarded_bytes, 0);
    drop(journal);
    store.delete_registered(id, created_at_ms).unwrap();
    assert!(!path.exists());

    for invalid in [-1, i64::MAX] {
        assert!(matches!(
            store.create(id, invalid, meta.clone()),
            Err(RolloutError::InvalidHistory)
        ));
    }
}

#[cfg(unix)]
#[test]
fn registered_files_reject_symlink_directories() {
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), directory.path().join("sessions")).unwrap();
    let store = RolloutStore::new(directory.path());
    let fixture = entries();
    let EntryPayload::Meta(meta) = &fixture[1].payload else {
        panic!("missing meta");
    };
    assert!(matches!(
        store.create(fixture[0].session_id, fixture[0].timestamp_ms, meta.clone()),
        Err(RolloutError::InvalidHistory)
    ));
    assert!(matches!(
        store.delete_registered(fixture[0].session_id, fixture[0].timestamp_ms),
        Err(RolloutError::InvalidHistory)
    ));
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[test]
fn append_reopen_lock_and_valid_uncommitted_tail() {
    let directory = tempfile::tempdir().unwrap();
    let store = RolloutStore::new(directory.path());
    let fixture = entries();
    let EntryPayload::Meta(meta) = &fixture[1].payload else {
        panic!()
    };
    let mut journal = store
        .create(fixture[0].session_id, fixture[0].timestamp_ms, meta.clone())
        .unwrap();
    assert!(matches!(store.open(fixture[0].session_id), Err(RolloutError::Busy)));
    for entry in &fixture[2..] {
        journal.append_entry(entry.clone()).unwrap();
    }
    let committed = fs::read(journal.path()).unwrap();
    let path = journal.path().to_owned();
    let actual = journal.entries().to_vec();
    drop(journal);
    let (journal, repair) = store.open(fixture[0].session_id).unwrap();
    assert_eq!(journal.entries(), actual);
    assert_eq!(repair.discarded_bytes, 0);
    drop(journal);
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(b"{\"schema_version\":1,\"session_id\":").unwrap();
    file.sync_all().unwrap();
    let (journal, repair) = store.open(fixture[0].session_id).unwrap();
    assert!(repair.discarded_bytes > 0);
    assert_eq!(fs::read(&path).unwrap(), committed);
    assert_eq!(journal.entries(), actual);
    assert!(repair.diagnostic_path.unwrap().is_file());
}

#[test]
fn unknown_version_fields_and_complete_corruption_are_preserved() {
    for tail in [
        "{\"schema_version\":2}",
        "{\"schema_version\":1,\"secret\":true}",
        "false",
        "{bad}\n",
        "\n",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let store = RolloutStore::new(directory.path());
        let fixture = entries();
        let EntryPayload::Meta(meta) = &fixture[1].payload else {
            panic!()
        };
        let journal = store
            .create(fixture[0].session_id, fixture[0].timestamp_ms, meta.clone())
            .unwrap();
        let path = journal.path().to_owned();
        drop(journal);
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(tail.as_bytes())
            .unwrap();
        let before = fs::read(&path).unwrap();
        assert!(store.open(fixture[0].session_id).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}

#[test]
fn valid_json_without_newline_is_not_promoted_to_committed() {
    let directory = tempfile::tempdir().unwrap();
    let store = RolloutStore::new(directory.path());
    let fixture = entries();
    let EntryPayload::Meta(meta) = &fixture[1].payload else {
        panic!()
    };
    let journal = store
        .create(fixture[0].session_id, fixture[0].timestamp_ms, meta.clone())
        .unwrap();
    let path = journal.path().to_owned();
    drop(journal);
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(encode_entry(&fixture[2], &fixture[..2]).unwrap().as_bytes())
        .unwrap();
    let (journal, repair) = store.open(fixture[0].session_id).unwrap();
    assert_eq!(journal.entries().len(), 2);
    assert!(repair.discarded_bytes > 0);
    assert_eq!(
        store.open(fixture[0].session_id).err().unwrap().to_string(),
        RolloutError::Busy.to_string()
    );
}

#[test]
fn config_updates_omit_session_envelope_and_ui_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let store = RolloutStore::new(directory.path());
    let fixture = entries();
    let EntryPayload::Meta(meta) = &fixture[1].payload else {
        panic!("missing meta")
    };
    let mut journal = store
        .create(fixture[0].session_id, fixture[0].timestamp_ms, meta.clone())
        .unwrap();
    let mut updated = meta.clone();
    updated.reasoning = Some("high".into());
    journal.append(EntryPayload::Meta(updated.clone()), 1001).unwrap();
    let text = fs::read_to_string(journal.path()).unwrap();
    let row: serde_json::Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
    assert!(row.get("session_id").is_none());
    assert!(row.get("schema_version").is_none());
    assert!(row.get("sequence").is_none());
    assert!(row["payload"]["data"].get("title").is_none());
    assert!(row["payload"]["data"].get("metadata_revision").is_none());
    drop(journal);
    let (journal, _) = store.open(fixture[0].session_id).unwrap();
    assert_eq!(journal.entries()[2].payload, EntryPayload::Meta(updated));
}
