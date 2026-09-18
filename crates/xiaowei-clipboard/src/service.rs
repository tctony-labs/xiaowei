use crate::{ClipboardCategory, ClipboardData, ClipboardItem, ListOptions, Result, Store};
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

pub trait ClipboardBackend: Send + 'static {
    fn change_count(&mut self) -> Result<i64>;
    fn read(&mut self) -> Result<Option<ClipboardData>>;
    fn write(&mut self, data: &ClipboardData) -> Result<()>;
}

struct State {
    store: Store,
    clipboard: Box<dyn ClipboardBackend>,
    last_count: Option<i64>,
    last_hash: Option<String>,
}

struct Worker {
    stop: mpsc::Sender<()>,
    thread: JoinHandle<()>,
}

pub struct Service {
    state: Arc<Mutex<State>>,
    worker: Mutex<Option<Worker>>,
    on_change: Arc<dyn Fn() + Send + Sync>,
}

impl Service {
    pub fn open(
        directory: &Path,
        clipboard: impl ClipboardBackend,
        on_change: impl Fn() + Send + Sync + 'static,
    ) -> Result<Self> {
        Ok(Self {
            state: Arc::new(Mutex::new(State {
                store: Store::open(directory)?,
                clipboard: Box::new(clipboard),
                last_count: None,
                last_hash: None,
            })),
            worker: Mutex::new(None),
            on_change: Arc::new(on_change),
        })
    }

    pub fn start(&self) -> Result<()> {
        let mut worker = self.worker.lock().map_err(|_| "Clipboard worker unavailable")?;
        if worker.is_some() {
            return Ok(());
        }
        let state = Arc::clone(&self.state);
        let on_change = Arc::clone(&self.on_change);
        let (stop, receiver) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("clipboard-monitor".into())
            .spawn(move || {
                log::info!("Clipboard monitoring started (500 ms)");
                let mut failed = false;
                while matches!(
                    receiver.recv_timeout(Duration::from_millis(500)),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    let result = poll(&state);
                    match result {
                        Ok(changed) => {
                            failed = false;
                            if changed {
                                on_change();
                            }
                        }
                        Err(error) => {
                            if !failed {
                                log::warn!("Clipboard capture failed: {error}");
                            }
                            failed = true;
                        }
                    }
                }
                log::info!("Clipboard monitoring stopped");
            })?;
        *worker = Some(Worker { stop, thread });
        Ok(())
    }

    pub fn stop(&self) -> Result<()> {
        let mut slot = self.worker.lock().map_err(|_| "Clipboard worker unavailable")?;
        if let Some(worker) = slot.take() {
            let _ = worker.stop.send(());
            worker.thread.join().map_err(|_| "Clipboard worker panicked")?;
        }
        Ok(())
    }

    pub fn poll_once(&self) -> Result<bool> {
        let changed = poll(&self.state)?;
        if changed {
            (self.on_change)();
        }
        Ok(changed)
    }

    pub fn list(&self, options: &ListOptions) -> Result<Vec<ClipboardItem>> {
        self.state
            .lock()
            .map_err(|_| "Clipboard unavailable")?
            .store
            .list(options)
    }

    pub fn get(&self, id: i64) -> Result<Option<ClipboardItem>> {
        self.state.lock().map_err(|_| "Clipboard unavailable")?.store.get(id)
    }

    pub fn add_text(&self, text: String) -> Result<ClipboardItem> {
        let item = self
            .state
            .lock()
            .map_err(|_| "Clipboard unavailable")?
            .store
            .capture(&ClipboardData::Text(text))?;
        (self.on_change)();
        Ok(item)
    }

    pub fn data(&self, id: i64) -> Result<ClipboardData> {
        self.state.lock().map_err(|_| "Clipboard unavailable")?.store.data(id)
    }

    pub fn copy(&self, id: i64) -> Result<()> {
        {
            let mut state = self.state.lock().map_err(|_| "Clipboard unavailable")?;
            let data = state.store.data(id)?;
            state.clipboard.write(&data)?;
            state.store.bump_use(id)?;
            // Read the next version normally: another application may write immediately after us.
            state.last_count = None;
            state.last_hash = Some(data.hash());
        }
        (self.on_change)();
        Ok(())
    }

    pub fn set_favorite(&self, id: i64, favorite: bool) -> Result<bool> {
        let changed = self
            .state
            .lock()
            .map_err(|_| "Clipboard unavailable")?
            .store
            .set_favorite(id, favorite)?;
        if changed {
            (self.on_change)();
        }
        Ok(changed)
    }

    pub fn categories(&self) -> Result<Vec<ClipboardCategory>> {
        self.state
            .lock()
            .map_err(|_| "Clipboard unavailable")?
            .store
            .categories()
    }

    pub fn save_category(&self, id: Option<i64>, name: &str, color: &str) -> Result<ClipboardCategory> {
        let category = self
            .state
            .lock()
            .map_err(|_| "Clipboard unavailable")?
            .store
            .save_category(id, name, color)?;
        (self.on_change)();
        Ok(category)
    }

    pub fn delete_category(&self, id: i64) -> Result<()> {
        self.state
            .lock()
            .map_err(|_| "Clipboard unavailable")?
            .store
            .delete_category(id)?;
        (self.on_change)();
        Ok(())
    }

    pub fn set_remark(&self, id: i64, remark: &str) -> Result<()> {
        self.state
            .lock()
            .map_err(|_| "Clipboard unavailable")?
            .store
            .set_remark(id, remark)?;
        (self.on_change)();
        Ok(())
    }

    pub fn set_category(&self, id: i64, category: Option<i64>) -> Result<()> {
        self.state
            .lock()
            .map_err(|_| "Clipboard unavailable")?
            .store
            .set_category(id, category)?;
        (self.on_change)();
        Ok(())
    }

    pub fn edit_text(&self, id: i64, text: String) -> Result<ClipboardItem> {
        let item = {
            let mut state = self.state.lock().map_err(|_| "Clipboard unavailable")?;
            let item = state.store.edit_text(id, text)?;
            state.last_hash = None;
            item
        };
        (self.on_change)();
        Ok(item)
    }

    pub fn delete(&self, id: i64) -> Result<bool> {
        let changed = {
            let mut state = self.state.lock().map_err(|_| "Clipboard unavailable")?;
            let changed = state.store.delete(id)?;
            if changed {
                state.last_hash = None;
            }
            changed
        };
        if changed {
            (self.on_change)();
        }
        Ok(changed)
    }

    pub fn clear_history(&self) -> Result<usize> {
        let count = {
            let mut state = self.state.lock().map_err(|_| "Clipboard unavailable")?;
            let count = state.store.clear_history()?;
            state.last_hash = None;
            count
        };
        if count > 0 {
            (self.on_change)();
        }
        Ok(count)
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn poll(state: &Mutex<State>) -> Result<bool> {
    let mut state = state.lock().map_err(|_| "Clipboard unavailable")?;
    let before = state.clipboard.change_count()?;
    if state.last_count == Some(before) {
        return Ok(false);
    }
    let data = state.clipboard.read()?;
    // The clipboard can change while a large image is being read; retry that version next time.
    if state.clipboard.change_count()? != before {
        return Ok(false);
    }
    let Some(data) = data.filter(|data| !data.is_empty()) else {
        state.last_count = Some(before);
        state.last_hash = None;
        return Ok(false);
    };
    let hash = data.hash();
    if state.last_hash.as_ref() == Some(&hash) {
        state.last_count = Some(before);
        return Ok(false);
    }
    let item = state.store.capture(&data)?;
    state.last_count = Some(before);
    state.last_hash = Some(hash);
    log::debug!("Clipboard captured id={} kind={}", item.id, item.kind);
    Ok(true)
}
