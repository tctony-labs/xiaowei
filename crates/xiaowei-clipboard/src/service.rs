use crate::{ClipboardCategory, ClipboardData, ClipboardItem, ListOptions, Result, Store};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

pub trait ClipboardBackend: Send + 'static {
    fn change_count(&mut self) -> Result<i64>;
    fn read(&mut self) -> Result<Option<ClipboardData>>;
    fn write(&mut self, data: &ClipboardData) -> Result<()>;
}

struct State {
    store: Store,
    resources: crate::resources::Resources,
    clipboard: Box<dyn ClipboardBackend>,
    last_count: Option<i64>,
    last_hash: Option<String>,
}

struct ClipboardChange {
    count: i64,
    hash: String,
    data: ClipboardData,
}

enum PollError {
    Read(Box<dyn std::error::Error + Send + Sync>),
    Save(Box<dyn std::error::Error + Send + Sync>),
}

struct Worker {
    stop: oneshot::Sender<()>,
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
        temporary_root: &Path,
        client: xw_gateway::invoke::Client,
        clipboard: impl ClipboardBackend,
        on_change: impl Fn() + Send + Sync + 'static,
    ) -> Result<Self> {
        Ok(Self {
            state: Arc::new(Mutex::new(State {
                store: Store::open(directory, client)?,
                resources: crate::resources::Resources::new(temporary_root)?,
                clipboard: Box::new(clipboard),
                last_count: None,
                last_hash: None,
            })),
            worker: Mutex::new(None),
            on_change: Arc::new(on_change),
        })
    }

    pub async fn initialize_with_client(&self, client: xw_gateway::invoke::Client) -> Result<()> {
        let mut state = self.state.lock().await;
        state.store.set_client(client);
        state.store.initialize().await
    }

    pub async fn initialize(&self) -> Result<()> {
        self.state.lock().await.store.initialize().await
    }

    pub async fn start(&self) -> Result<()> {
        let mut worker = self.worker.lock().await;
        if worker.is_some() {
            return Ok(());
        }
        let state = self.state.clone();
        let on_change = self.on_change.clone();
        let (stop, mut receiver) = oneshot::channel();
        let thread = tokio::spawn(async move {
            log::info!("Clipboard monitoring started (500 ms)");
            let mut failed = None;
            loop {
                tokio::select! {
                    _ = &mut receiver => break,
                    _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                }
                match poll(&state).await {
                    Ok(changed) => {
                        failed = None;
                        if changed {
                            on_change();
                        }
                    }
                    Err(error) => {
                        let (level, message, source) = match error {
                            PollError::Read(source) => (log::Level::Warn, "Clipboard read failed", source),
                            PollError::Save(source) => (log::Level::Error, "Clipboard history save failed", source),
                        };
                        if failed != Some(level) {
                            log::log!(level, "{message}: {source}");
                        }
                        failed = Some(level);
                    }
                }
            }
            log::info!("Clipboard monitoring stopped");
        });
        *worker = Some(Worker { stop, thread });
        Ok(())
    }

    pub async fn stop(&self) -> Result<()> {
        let mut worker = self.worker.lock().await;
        if let Some(worker) = worker.take() {
            let _ = worker.stop.send(());
            worker.thread.await?;
        }
        Ok(())
    }

    pub async fn poll_once(&self) -> Result<bool> {
        let changed = poll(&self.state).await.map_err(|error| match error {
            PollError::Read(source) | PollError::Save(source) => source,
        })?;
        if changed {
            (self.on_change)();
        }
        Ok(changed)
    }

    pub async fn resource_paths(&self, id: i64, index: Option<u32>) -> Result<Vec<String>> {
        let state = self.state.lock().await;
        let item = state.store.get(id).await?.ok_or("Clipboard item no longer exists")?;
        state.resources.resolve(item, index)
    }

    pub async fn close_resources(&self) -> Result<()> {
        self.state.lock().await.resources.close()
    }

    pub async fn list(&self, options: &ListOptions) -> Result<Vec<ClipboardItem>> {
        self.state.lock().await.store.list(options).await
    }

    pub async fn get(&self, id: i64) -> Result<Option<ClipboardItem>> {
        self.state.lock().await.store.get(id).await
    }

    pub async fn add_text(&self, text: String) -> Result<ClipboardItem> {
        let item = self
            .state
            .lock()
            .await
            .store
            .capture(&ClipboardData::Text(text))
            .await?;
        (self.on_change)();
        Ok(item)
    }

    pub async fn data(&self, id: i64) -> Result<ClipboardData> {
        self.state.lock().await.store.data(id).await
    }

    pub async fn copy(&self, id: i64) -> Result<()> {
        {
            let mut state = self.state.lock().await;
            let data = state.store.data(id).await?;
            state.clipboard.write(&data)?;
            state.store.bump_use(id).await?;
            // Read the next version normally: another application may write immediately after us.
            state.last_count = None;
            state.last_hash = Some(data.hash());
        }
        (self.on_change)();
        Ok(())
    }

    pub async fn set_favorite(&self, id: i64, favorite: bool) -> Result<bool> {
        let changed = self.state.lock().await.store.set_favorite(id, favorite).await?;
        if changed {
            (self.on_change)();
        }
        Ok(changed)
    }

    pub async fn categories(&self) -> Result<Vec<ClipboardCategory>> {
        self.state.lock().await.store.categories().await
    }

    pub async fn save_category(&self, id: Option<i64>, name: &str, color: &str) -> Result<ClipboardCategory> {
        let category = self.state.lock().await.store.save_category(id, name, color).await?;
        (self.on_change)();
        Ok(category)
    }

    pub async fn delete_category(&self, id: i64) -> Result<()> {
        self.state.lock().await.store.delete_category(id).await?;
        (self.on_change)();
        Ok(())
    }

    pub async fn set_remark(&self, id: i64, remark: &str) -> Result<()> {
        self.state.lock().await.store.set_remark(id, remark).await?;
        (self.on_change)();
        Ok(())
    }

    pub async fn set_category(&self, id: i64, category: Option<i64>) -> Result<()> {
        self.state.lock().await.store.set_category(id, category).await?;
        (self.on_change)();
        Ok(())
    }

    pub async fn edit_text(&self, id: i64, text: String) -> Result<ClipboardItem> {
        let item = {
            let mut state = self.state.lock().await;
            let item = state.store.edit_text(id, text).await?;
            state.last_hash = None;
            item
        };
        (self.on_change)();
        Ok(item)
    }

    pub async fn delete(&self, id: i64) -> Result<bool> {
        let changed = {
            let mut state = self.state.lock().await;
            let changed = state.store.delete(id).await?;
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

    pub async fn purge_ordinary(&self) -> Result<usize> {
        self.purge_ordinary_before(crate::store::current_time_ms()?).await
    }

    pub async fn purge_expired(&self, retention_days: i32) -> Result<usize> {
        if !matches!(retention_days, 1 | 7 | 15 | 30) {
            return Err("Invalid retention period".into());
        }
        let cutoff = crate::store::current_time_ms()? - i64::from(retention_days) * 24 * 60 * 60 * 1000;
        self.purge_ordinary_before(cutoff).await
    }

    async fn purge_ordinary_before(&self, cutoff: i64) -> Result<usize> {
        let count = {
            let mut state = self.state.lock().await;
            let count = state.store.purge_ordinary_before(cutoff).await?;
            if count > 0 {
                state.last_hash = None;
            }
            count
        };
        if count > 0 {
            (self.on_change)();
        }
        Ok(count)
    }

    pub async fn clear_history(&self) -> Result<usize> {
        let count = {
            let mut state = self.state.lock().await;
            let count = state.store.clear_history().await?;
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
        if let Some(worker) = self.worker.get_mut().take() {
            let _ = worker.stop.send(());
            worker.thread.abort();
        }
    }
}

fn read_clipboard_change(state: &mut State) -> Result<Option<ClipboardChange>> {
    let before = state.clipboard.change_count()?;
    if state.last_count == Some(before) {
        return Ok(None);
    }
    let data = state.clipboard.read()?;
    // The clipboard can change while a large image is being read; retry that version next time.
    if state.clipboard.change_count()? != before {
        return Ok(None);
    }
    let Some(data) = data.filter(|data| !data.is_empty()) else {
        state.last_count = Some(before);
        state.last_hash = None;
        return Ok(None);
    };
    let hash = data.hash();
    if state.last_hash.as_ref() == Some(&hash) {
        state.last_count = Some(before);
        return Ok(None);
    }
    Ok(Some(ClipboardChange {
        count: before,
        hash,
        data,
    }))
}

async fn poll(state: &Mutex<State>) -> std::result::Result<bool, PollError> {
    let mut state = state.lock().await;
    let Some(change) = read_clipboard_change(&mut state).map_err(PollError::Read)? else {
        return Ok(false);
    };

    let item = state.store.capture(&change.data).await.map_err(PollError::Save)?;
    state.last_count = Some(change.count);
    state.last_hash = Some(change.hash);
    log::debug!("Clipboard history saved id={} kind={}", item.id, item.kind);
    Ok(true)
}
