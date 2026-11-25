use crate::Store;
use std::time::Duration;
use tokio::sync::Notify;

pub(crate) async fn run(store: Store, ready: &Notify, on_change: impl Fn()) {
    let mut after_id = 0;
    loop {
        let (id, image) = match store.next_image_for_ocr(after_id).await {
            Ok(Some(candidate)) => candidate,
            Ok(None) => {
                ready.notified().await;
                continue;
            }
            Err(error) => {
                log::error!("Clipboard OCR could not load pending images: {error}");
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }
        };

        // Advance past bad attachments for this run. Pending records can retry on restart.
        after_id = id;
        let text =
            match tokio::task::spawn_blocking(move || xw_platform::ocr::recognize_text(&image))
                .await
            {
                Ok(Ok(text)) => text,
                Ok(Err(error)) => {
                    log::warn!("Clipboard OCR recognition failed id={id}: {error}");
                    continue;
                }
                Err(error) => {
                    log::error!("Clipboard OCR worker failed id={id}: {error}");
                    continue;
                }
            };

        let has_text = !text.is_empty();
        match store.complete_image_ocr(id, text).await {
            Ok(true) => {
                log::debug!("Clipboard OCR saved id={id} has_text={has_text}");
                if has_text {
                    on_change();
                }
            }
            Ok(false) => {}
            Err(error) => log::error!("Clipboard OCR could not save result id={id}: {error}"),
        }
    }
}
