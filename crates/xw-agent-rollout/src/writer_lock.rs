use std::{
    fs::{File, OpenOptions},
    path::Path,
};

use crate::{Result, RolloutError};

pub(crate) struct WriterLock {
    _file: File,
}

impl WriterLock {
    pub(crate) fn acquire(path: &Path) -> Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(std::fs::TryLockError::WouldBlock) => Err(RolloutError::Busy),
            Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
        }
    }
}
// Closing releases the OS lock. Never unlink the lock file: other writers must use the same inode.
