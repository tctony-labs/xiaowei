use napi_derive::napi;
use std::sync::{Arc, Mutex};
use xiaowei_platform::focus;

#[napi]
pub fn frontmost_process() -> Option<u32> {
    focus::frontmost_process()
}

#[napi]
pub struct FocusSnapshot {
    inner: Arc<Mutex<Option<focus::FocusSnapshot>>>,
    process_id: u32,
}

#[napi]
pub async fn capture_focus() -> napi::Result<Option<FocusSnapshot>> {
    tokio::task::spawn_blocking(|| {
        focus::FocusSnapshot::capture().map(|snapshot| FocusSnapshot {
            process_id: snapshot.process_id(),
            inner: Arc::new(Mutex::new(Some(snapshot))),
        })
    })
    .await
    .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
impl FocusSnapshot {
    #[napi(getter)]
    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    #[napi]
    pub fn release(&self) {
        self.inner.lock().unwrap().take();
    }

    #[napi]
    pub async fn restore(&self, expected_process: u32) -> napi::Result<bool> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            inner
                .lock()
                .unwrap()
                .as_mut()
                .map(|snapshot| snapshot.restore(expected_process))
        })
        .await
        .map_err(|error| napi::Error::from_reason(error.to_string()))?
        .ok_or_else(|| napi::Error::from_reason("Focus snapshot released"))
    }

    #[napi]
    pub async fn is_frontmost(&self) -> napi::Result<bool> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || inner.lock().unwrap().as_ref().map(focus::FocusSnapshot::is_frontmost))
            .await
            .map_err(|error| napi::Error::from_reason(error.to_string()))?
            .ok_or_else(|| napi::Error::from_reason("Focus snapshot released"))
    }
}
