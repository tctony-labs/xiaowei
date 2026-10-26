use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{Mutex, watch};
use tokio_util::sync::CancellationToken;

use crate::{LocalErrorKind, MobileError, Result};

pub use xw_api::connection::{Authentication, Snapshot as ConnectionSnapshot, Status};

pub struct ConnectionSubscription {
    updates: Mutex<watch::Receiver<ConnectionSnapshot>>,
    first: AtomicBool,
    stop: CancellationToken,
}

impl ConnectionSubscription {
    pub(crate) fn new(
        updates: watch::Receiver<ConnectionSnapshot>,
        stop: CancellationToken,
    ) -> Arc<Self> {
        Arc::new(Self {
            updates: Mutex::new(updates),
            first: AtomicBool::new(true),
            stop,
        })
    }

    pub async fn next(&self) -> Result<Option<ConnectionSnapshot>> {
        let mut updates = self
            .updates
            .try_lock()
            .map_err(|_| MobileError::local(LocalErrorKind::Busy, "连接订阅已有等待者"))?;
        if self.stop.is_cancelled() {
            return Ok(None);
        }
        if self.first.swap(false, Ordering::SeqCst) {
            return Ok(Some(updates.borrow_and_update().clone()));
        }
        tokio::select! {
            biased;
            _ = self.stop.cancelled() => Ok(None),
            changed = updates.changed() => {
                Ok(changed.ok().map(|_| updates.borrow_and_update().clone()))
            }
        }
    }

    pub fn close(&self) {
        self.stop.cancel();
    }
}

impl Drop for ConnectionSubscription {
    fn drop(&mut self) {
        self.close();
    }
}
