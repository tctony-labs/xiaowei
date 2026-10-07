use std::{
    fs::{self, File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use chrono::{DateTime, Datelike};
use xw_agent_types::{EntryId, EntryPayload, JournalEntry, Sequence, SessionId, encode_entry};

use crate::{Repair, Result, RolloutError, recovery::read_and_repair, writer_lock::WriterLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriterState {
    Ready,
    NeedsCheck,
}

pub struct RolloutStore {
    root: PathBuf,
}

impl RolloutStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn create(&self, id: SessionId, created_at_ms: i64, meta: xw_agent_types::SessionMeta) -> Result<Journal> {
        let path = self.registered_path(id, created_at_ms)?;
        let directory = path.parent().expect("session path has a directory");
        fs::create_dir_all(directory)?;
        let lock = self.lock(id)?;
        let file = OpenOptions::new().create_new(true).read(true).write(true).open(&path)?;
        let mut journal = Journal {
            id,
            root: self.root.clone(),
            path: path.clone(),
            file,
            _lock: lock,
            entries: Vec::new(),
            committed_bytes: 0,
            state: WriterState::Ready,
            #[cfg(any(test, feature = "test-support"))]
            fault: None,
        };
        let initialized = journal
            .append(EntryPayload::SessionHeader, created_at_ms)
            .and_then(|_| journal.append(EntryPayload::Meta(meta), created_at_ms));
        if let Err(error) = initialized {
            fs::remove_file(&journal.path)?;
            return Err(error);
        }
        // Persist the directory entry after both initialization records.
        #[cfg(unix)]
        File::open(directory)?.sync_all()?;
        Ok(journal)
    }

    pub fn open(&self, id: SessionId) -> Result<(Journal, Repair)> {
        let lock = self.lock(id)?;
        let path = self.locate(id)?;
        self.open_path(id, lock, path)
    }

    pub fn open_registered(&self, id: SessionId, created_at_ms: i64) -> Result<(Journal, Repair)> {
        let path = self.registered_path(id, created_at_ms)?;
        let lock = self.lock(id)?;
        if !path.symlink_metadata()?.is_file() {
            return Err(RolloutError::InvalidHistory);
        }
        self.open_path(id, lock, path)
    }

    fn open_path(&self, id: SessionId, lock: WriterLock, path: PathBuf) -> Result<(Journal, Repair)> {
        let mut file = OpenOptions::new().read(true).write(true).open(&path)?;
        let (entries, repair) = read_and_repair(&mut file, &path, id)?;
        if entries.is_empty() {
            return Err(RolloutError::InvalidHistory);
        }
        let committed_bytes = file.metadata()?.len();
        file.seek(SeekFrom::End(0))?;
        Ok((
            Journal {
                id,
                root: self.root.clone(),
                path,
                file,
                _lock: lock,
                entries,
                committed_bytes,
                state: WriterState::Ready,
                #[cfg(any(test, feature = "test-support"))]
                fault: None,
            },
            repair,
        ))
    }

    fn registered_path(&self, id: SessionId, created_at_ms: i64) -> Result<PathBuf> {
        if created_at_ms < 0 {
            return Err(RolloutError::InvalidHistory);
        }
        let date = DateTime::from_timestamp_millis(created_at_ms).ok_or(RolloutError::InvalidHistory)?;
        let parts = [
            "sessions".into(),
            format!("{:04}", date.year()),
            format!("{:02}", date.month()),
        ];
        let mut directory = self.root.clone();
        for part in &parts {
            directory.push(part);
            match directory.symlink_metadata() {
                Ok(meta) if meta.is_dir() && !meta.is_symlink() => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(RolloutError::InvalidHistory),
            }
        }
        Ok(directory.join(format!("{id}.jsonl")))
    }

    /// Claim only known owned files; do not read history or enumerate directories.
    pub fn claim_registered(&self, id: SessionId, created_at_ms: i64) -> Result<SessionFiles> {
        Ok(SessionFiles {
            root: self.root.clone(),
            path: self.registered_path(id, created_at_ms)?,
            id,
            _lock: self.lock(id)?,
        })
    }

    /// SQLite already owns the deleting state. No permanent deletion marker.
    pub fn delete_registered(&self, id: SessionId, created_at_ms: i64) -> Result<()> {
        self.claim_registered(id, created_at_ms)?.delete()
    }

    fn lock(&self, id: SessionId) -> Result<WriterLock> {
        let directory = self.root.join("locks");
        fs::create_dir_all(&directory)?;
        WriterLock::acquire(&directory.join(format!("{id}.lock")))
    }

    pub fn session_ids(&self) -> Result<Vec<SessionId>> {
        let directory = self.root.join("sessions");
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut ids = Vec::new();
        for year in fs::read_dir(directory)? {
            let year = year?;
            if !year.file_type()?.is_dir() {
                continue;
            }
            for month in fs::read_dir(year.path())? {
                let month = month?;
                if !month.file_type()?.is_dir() {
                    continue;
                }
                for file in fs::read_dir(month.path())? {
                    let file = file?;
                    if !file.file_type()?.is_file() || file.path().extension().is_none_or(|ext| ext != "jsonl") {
                        continue;
                    }
                    if let Some(id) = file
                        .path()
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .and_then(|stem| stem.parse().ok())
                        && !self.root.join("deletions").join(format!("{id}.json")).exists()
                    {
                        ids.push(id);
                    }
                }
            }
        }
        ids.sort();
        ids.dedup();
        Ok(ids)
    }

    fn locate(&self, id: SessionId) -> Result<PathBuf> {
        for year in fs::read_dir(self.root.join("sessions"))? {
            let year = year?;
            if !year.file_type()?.is_dir() {
                continue;
            }
            for month in fs::read_dir(year.path())? {
                let month = month?;
                if !month.file_type()?.is_dir() {
                    continue;
                }
                let path = month.path().join(format!("{id}.jsonl"));
                if path.symlink_metadata().is_ok_and(|meta| meta.is_file()) {
                    return Ok(path);
                }
            }
        }
        Err(std::io::Error::from(std::io::ErrorKind::NotFound).into())
    }
}

/// File ownership held across the caller's directory transaction.
pub struct SessionFiles {
    root: PathBuf,
    path: PathBuf,
    id: SessionId,
    _lock: WriterLock,
}

impl SessionFiles {
    pub fn delete(&self) -> Result<()> {
        let path = &self.path;
        let root = &self.root;
        let id = self.id;
        match fs::remove_file(path) {
            Ok(()) => {
                #[cfg(unix)]
                File::open(path.parent().ok_or(RolloutError::InvalidHistory)?)?.sync_all()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let workspaces = root.join("workspaces");
        if workspaces.symlink_metadata().is_ok_and(|meta| meta.is_symlink()) {
            return Err(RolloutError::InvalidHistory);
        }
        let workspace = workspaces.join(id.to_string());
        match workspace.symlink_metadata() {
            Ok(meta) if meta.is_dir() && !meta.is_symlink() => fs::remove_dir_all(workspace)?,
            Ok(_) => fs::remove_file(workspace)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }
}

pub struct Journal {
    id: SessionId,
    root: PathBuf,
    path: PathBuf,
    file: File,
    _lock: WriterLock,
    entries: Vec<JournalEntry>,
    committed_bytes: u64,
    state: WriterState,
    #[cfg(any(test, feature = "test-support"))]
    fault: Option<(usize, TestFault)>,
}

impl Journal {
    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub fn fail_next_append(&mut self, fault: TestFault) {
        self.fail_append_after(0, fault);
    }

    #[cfg(feature = "test-support")]
    #[doc(hidden)]
    pub fn fail_append_after(&mut self, successful_appends: usize, fault: TestFault) {
        self.fault = Some((successful_appends, fault));
    }

    pub fn delete(&mut self, deleted_at_ms: i64) -> Result<()> {
        let directory = self.root.join("deletions");
        fs::create_dir_all(&directory)?;
        let marker = xw_agent_types::DeletionMarker {
            schema_version: 1,
            session_id: self.id,
            journal_relpath: self
                .path
                .strip_prefix(&self.root)
                .map_err(|_| RolloutError::InvalidHistory)?
                .to_string_lossy()
                .replace('\\', "/"),
            workspace_relpath: format!("workspaces/{}", self.id),
            deleted_at_ms,
            committed_sequence: Sequence(self.entries.len() as u64),
        };
        let encoded = xw_agent_types::encode_deletion_marker(&marker).map_err(|_| RolloutError::InvalidHistory)?;
        let marker_path = directory.join(format!("{}.json", self.id));
        let temporary = directory.join(format!("{}.tmp", self.id));
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(encoded.as_bytes())?;
        file.sync_all()?;
        fs::rename(temporary, marker_path)?;
        #[cfg(unix)]
        File::open(&directory)?.sync_all()?;
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let workspace = self.root.join(&marker.workspace_relpath);
        if let Ok(meta) = workspace.symlink_metadata() {
            if meta.is_symlink() {
                fs::remove_file(workspace)?;
            } else if meta.is_dir() {
                fs::remove_dir_all(workspace)?;
            }
        }
        Ok(())
    }

    pub fn entries(&self) -> &[JournalEntry] {
        &self.entries
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn state(&self) -> WriterState {
        self.state
    }

    pub fn append(&mut self, payload: EntryPayload, timestamp_ms: i64) -> Result<JournalEntry> {
        if self.state == WriterState::NeedsCheck {
            return Err(RolloutError::NeedsCheck);
        }
        let entry = JournalEntry {
            schema_version: xw_agent_types::HISTORY_VERSION,
            session_id: self.id,
            entry_id: EntryId::new(),
            sequence: Sequence(self.entries.len() as u64 + 1),
            timestamp_ms,
            payload,
        };
        self.append_entry(entry)
    }

    /// Accept caller-owned stable entry identity, preserving references across a group.
    pub fn append_entry(&mut self, entry: JournalEntry) -> Result<JournalEntry> {
        if self.state == WriterState::NeedsCheck {
            return Err(RolloutError::NeedsCheck);
        }
        xw_agent_types::validate_entry(&entry)?;
        let encoded = encode_entry(&entry, &self.entries).map_err(|_| RolloutError::InvalidHistory)?;
        // Keep the live cache identical to replay, including fields derived by the compact codec.
        let entry = xw_agent_types::decode_entry(&encoded, &self.entries).map_err(|_| RolloutError::InvalidHistory)?;
        let result = (|| -> std::io::Result<()> {
            #[cfg(any(test, feature = "test-support"))]
            if self.fault.is_some_and(|(remaining, _)| remaining == 0) {
                let (_, fault) = self.fault.take().expect("fault is set");
                match fault {
                    TestFault::BeforeWrite => {}
                    TestFault::Partial => self.file.write_all(&encoded.as_bytes()[..encoded.len() / 2])?,
                    TestFault::AfterLine | TestFault::Sync => {
                        self.file.write_all(encoded.as_bytes())?;
                        self.file.write_all(b"\n")?;
                        if matches!(fault, TestFault::Sync) {
                            self.file.flush()?;
                        }
                    }
                }
                return Err(std::io::Error::from(std::io::ErrorKind::StorageFull));
            }
            #[cfg(any(test, feature = "test-support"))]
            if let Some((remaining, _)) = &mut self.fault {
                *remaining -= 1;
            }
            self.file.write_all(encoded.as_bytes())?;
            self.file.write_all(b"\n")?;
            self.file.flush()?;
            self.file.sync_data()
        })();
        if let Err(error) = result {
            self.state = WriterState::NeedsCheck;
            return Err(error.into());
        }
        self.committed_bytes += encoded.len() as u64 + 1;
        self.entries.push(entry.clone());
        Ok(entry)
    }

    // Used only after a known local write failure. Even a complete line whose sync failed
    // is uncommitted; do not promote it by reopening and scanning it as ordinary history.
    pub fn check_after_failure(&mut self) -> Result<Repair> {
        if self.state == WriterState::Ready {
            return Ok(Repair::default());
        }
        self.file.seek(SeekFrom::Start(self.committed_bytes))?;
        let mut tail = Vec::new();
        std::io::Read::read_to_end(&mut self.file, &mut tail)?;
        let diagnostic_path = if tail.is_empty() {
            None
        } else {
            let path = self.path.with_extension(format!("jsonl.tail-{}", EntryId::new()));
            let mut file = OpenOptions::new().create_new(true).write(true).open(&path)?;
            file.write_all(&tail)?;
            file.sync_all()?;
            Some(path)
        };
        self.file.set_len(self.committed_bytes)?;
        self.file.sync_data()?;
        let (entries, _) = read_and_repair(&mut self.file, &self.path, self.id)?;
        self.file.seek(SeekFrom::End(0))?;
        self.entries = entries;
        self.state = WriterState::Ready;
        Ok(Repair {
            discarded_bytes: tail.len() as u64,
            diagnostic_path,
        })
    }
}

#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Copy)]
pub enum TestFault {
    BeforeWrite,
    Partial,
    AfterLine,
    Sync,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_writes_keep_the_confirmed_prefix_and_require_an_explicit_check() {
        for fault in [
            TestFault::BeforeWrite,
            TestFault::Partial,
            TestFault::AfterLine,
            TestFault::Sync,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let entries = xw_agent_types::decode_history(include_str!("../tests/fixtures/basic.jsonl")).unwrap();
            let EntryPayload::Meta(meta) = &entries[1].payload else {
                panic!()
            };
            let store = RolloutStore::new(directory.path());
            let mut journal = store
                .create(entries[0].session_id, entries[0].timestamp_ms, meta.clone())
                .unwrap();
            let confirmed = fs::read(journal.path()).unwrap();
            journal.fault = Some((0, fault));
            assert!(
                journal
                    .append(entries[2].payload.clone(), entries[2].timestamp_ms)
                    .is_err()
            );
            assert_eq!(journal.entries().len(), 2);
            assert_eq!(journal.state(), WriterState::NeedsCheck);
            assert!(matches!(
                journal.append(entries[2].payload.clone(), 1000),
                Err(RolloutError::NeedsCheck)
            ));
            journal.check_after_failure().unwrap();
            assert_eq!(fs::read(journal.path()).unwrap(), confirmed);
            journal
                .append(entries[2].payload.clone(), entries[2].timestamp_ms)
                .unwrap();
            assert_eq!(journal.entries()[2].sequence, Sequence(3));
        }
    }
}
