use std::{
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use xw_agent_rollout::{RolloutError, RolloutStore};
use xw_agent_types::*;

#[test]
fn lock_child() {
    let Ok(root) = std::env::var("XW_ROLLOUT_LOCK_TEST_ROOT") else {
        return;
    };
    let id = std::env::var("XW_ROLLOUT_LOCK_TEST_ID").unwrap().parse().unwrap();
    let store = RolloutStore::new(&root);
    if std::env::var("XW_ROLLOUT_LOCK_TEST_MODE").unwrap() == "busy" {
        assert!(matches!(store.open(id), Err(RolloutError::Busy)));
    } else {
        let _journal = store.open(id).unwrap();
        std::fs::write(std::path::Path::new(&root).join("child-ready"), b"ready").unwrap();
        if std::env::var("XW_ROLLOUT_LOCK_TEST_MODE").unwrap() == "hold" {
            loop {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

#[test]
fn separate_process_conflicts_then_releases_after_normal_or_abnormal_exit() {
    let directory = tempfile::tempdir().unwrap();
    let entries = decode_history(include_str!("fixtures/basic.jsonl")).unwrap();
    let entry = &entries[0];
    let EntryPayload::Meta(meta) = entries[1].payload.clone() else {
        panic!()
    };
    let store = RolloutStore::new(directory.path());
    let journal = store.create(entry.session_id, entry.timestamp_ms, meta).unwrap();
    let child = |mode: &str| {
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "lock_child", "--nocapture"])
            .env("XW_ROLLOUT_LOCK_TEST_ROOT", directory.path())
            .env("XW_ROLLOUT_LOCK_TEST_ID", entry.session_id.to_string())
            .env("XW_ROLLOUT_LOCK_TEST_MODE", mode)
            .stdout(Stdio::null())
            .spawn()
            .unwrap()
    };
    assert!(child("busy").wait().unwrap().success());
    drop(journal);
    assert!(child("open").wait().unwrap().success());
    std::fs::remove_file(directory.path().join("child-ready")).unwrap();
    let mut holder = child("hold");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !directory.path().join("child-ready").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(matches!(store.open(entry.session_id), Err(RolloutError::Busy)));
    holder.kill().unwrap();
    holder.wait().unwrap();
    assert!(store.open(entry.session_id).is_ok());
}
