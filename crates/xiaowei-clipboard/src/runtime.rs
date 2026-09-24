use crate::{gateway_binding::xiaowei_storage_settings_service as settings, Result, Service};
use prost::{Message, Name};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;
use xw_contracts::xiaowei::{common::Empty, storage::SettingsChanged};
use xw_gateway::{event::EventSubscription, invoke::Client};

#[derive(Default)]
pub(crate) struct Runtime {
    closed: bool,
    worker: Option<Worker>,
}

struct Worker {
    stop: oneshot::Sender<()>,
    thread: JoinHandle<()>,
    subscription: EventSubscription,
}

impl Service {
    pub async fn start_services(self: &Arc<Self>, client: Client) -> Result<()> {
        let mut runtime = self.runtime.lock().await;
        if runtime.closed {
            return Err("Clipboard services closed".into());
        }
        if runtime.worker.is_some() {
            return Ok(());
        }
        // Subscribe before loading the snapshot; a newer event wins over an in-flight Get.
        let (updates, mut values) = watch::channel(None);
        let subscription = client
            .subscribe(&SettingsChanged::full_name(), None, false, move |bytes| {
                let updates = updates.clone();
                async move {
                    match SettingsChanged::decode(bytes.as_slice()) {
                        Ok(event) => {
                            if let Some(snapshot) = event.snapshot {
                                updates.send_replace(Some(snapshot));
                            }
                        }
                        Err(error) => log::error!("Clipboard settings event failed: {error}"),
                    }
                }
            })
            .await?;
        let snapshot = match settings::GET.call(&client, Empty {}).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                subscription.close();
                return Err(error.into());
            }
        };
        let mut current = values.borrow_and_update().clone().unwrap_or(snapshot);
        if let Err(error) = self.apply_monitoring(current.clipboard_enabled).await {
            subscription.close();
            return Err(error);
        }
        let service = Arc::downgrade(self);
        let (stop, mut cancelled) = oneshot::channel();
        let thread = tokio::spawn(async move {
            let timer = tokio::time::sleep(Duration::from_secs(30));
            tokio::pin!(timer);
            loop {
                tokio::select! {
                    biased;
                    _ = &mut cancelled => break,
                    changed = values.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        let next = values.borrow_and_update().clone();
                        let Some(next) = next else {
                            continue;
                        };
                        let Some(service) = service.upgrade() else {
                            break;
                        };
                        if next.clipboard_enabled != current.clipboard_enabled {
                            if let Err(error) = service.apply_monitoring(next.clipboard_enabled).await {
                                log::error!("Clipboard monitoring setting failed: {error}");
                            }
                        }
                        if next.clipboard_auto_paste && !current.clipboard_auto_paste {
                            service.request_paste_permission().await;
                        }
                        if next.clipboard_retention_days != current.clipboard_retention_days {
                            cleanup(&service, next.clipboard_retention_days).await;
                        }
                        current = next;
                    }
                    _ = &mut timer => {
                        let Some(service) = service.upgrade() else {
                            break;
                        };
                        match settings::GET.call(&client, Empty {}).await {
                            Ok(snapshot) => cleanup(&service, snapshot.clipboard_retention_days).await,
                            Err(error) => log::error!("Clipboard retention settings failed: {error}"),
                        }
                        timer.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(3600));
                    }
                }
            }
        });
        runtime.worker = Some(Worker {
            stop,
            thread,
            subscription,
        });
        Ok(())
    }

    pub async fn stop_services(&self) -> Result<()> {
        let mut runtime = self.runtime.lock().await;
        runtime.closed = true;
        if let Some(worker) = runtime.worker.take() {
            worker.subscription.close();
            let _ = worker.stop.send(());
            worker.thread.await?;
        }
        self.stop().await
    }

    async fn apply_monitoring(&self, enabled: bool) -> Result<()> {
        if !cfg!(target_os = "macos") {
            return Ok(());
        }
        if enabled {
            self.start().await
        } else {
            self.stop().await
        }
    }
}

async fn cleanup(service: &Service, days: i32) {
    if days == -1 {
        return;
    }
    if let Err(error) = service.purge_expired(days).await {
        log::error!("Clipboard retention cleanup failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ClipboardBackend, ClipboardData};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use xw_contracts::xiaowei::{clipboard::DeletedClipboardEntities, storage::SettingsSnapshot};
    use xw_gateway::{CallContext, XwInvokeRegistry};

    struct Backend;
    impl ClipboardBackend for Backend {
        fn change_count(&mut self) -> Result<i64> {
            Ok(0)
        }
        fn read(&mut self) -> Result<Option<ClipboardData>> {
            Ok(None)
        }
        fn write(&mut self, _: &ClipboardData) -> Result<()> {
            Ok(())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn cleanup_waits_thirty_seconds_repeats_hourly_and_stops_with_runtime() {
        use crate::gateway_binding::xiaowei_clipboard_clipboard_dao_service as dao;
        let directory = tempfile::tempdir().unwrap();
        let registry = XwInvokeRegistry::new();
        registry
            .register_owner(
                "settings",
                vec![settings::GET.handler(|_, _| async {
                    Ok(SettingsSnapshot {
                        clipboard_retention_days: 30,
                        ..Default::default()
                    })
                })],
                xiaowei_storage::settings::gateway::events(),
            )
            .unwrap();
        let cycles = Arc::new(AtomicUsize::new(0));
        let count = cycles.clone();
        registry
            .register_owner(
                "dao",
                vec![dao::PURGE_ORDINARY_BATCH.handler(move |_, _| {
                    count.fetch_add(1, Ordering::SeqCst);
                    async { Ok(DeletedClipboardEntities::default()) }
                })],
                vec![],
            )
            .unwrap();
        let client = registry.client(CallContext::trusted("runtime"));
        let service =
            Arc::new(Service::open(directory.path(), directory.path(), client.clone(), Backend, || {}).unwrap());
        service.start_services(client.clone()).await.unwrap();
        service.start_services(client.clone()).await.unwrap();
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(29)).await;
        tokio::task::yield_now().await;
        assert_eq!(cycles.load(Ordering::SeqCst), 0);
        tokio::time::advance(Duration::from_secs(1)).await;
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(cycles.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(3600)).await;
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(cycles.load(Ordering::SeqCst), 2);
        service.stop_services().await.unwrap();
        tokio::time::advance(Duration::from_secs(3600)).await;
        tokio::task::yield_now().await;
        assert_eq!(cycles.load(Ordering::SeqCst), 2);
        assert!(service.start_services(client).await.is_err());
        service.stop_services().await.unwrap();
    }
}
