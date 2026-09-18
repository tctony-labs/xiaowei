use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::Arc;
use xiaowei_clipboard::{ClipboardData, Service, SystemClipboard};

pub mod logging;

type ChangeCallback = ThreadsafeFunction<(), (), (), napi::Status, false, true, 1>;

#[napi(object)]
pub struct ClipboardItem {
    pub id: String,
    pub kind: String,
    pub image_path: Option<String>,
    pub text: Option<String>,
    pub paths: Vec<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub created_at: f64,
    pub last_used_at: f64,
    pub use_count: u32,
    pub favorite: bool,
    pub remark: Option<String>,
    pub category_id: Option<String>,
}

impl From<xiaowei_clipboard::ClipboardItem> for ClipboardItem {
    fn from(item: xiaowei_clipboard::ClipboardItem) -> Self {
        Self {
            id: item.id,
            kind: item.kind,
            image_path: item.image_path,
            text: item.text,
            paths: item.paths,
            width: item.width,
            height: item.height,
            created_at: item.created_at as f64,
            last_used_at: item.last_used_at as f64,
            use_count: item.use_count,
            favorite: item.favorite,
            remark: item.remark,
            category_id: item.category_id,
        }
    }
}

#[napi(object)]
pub struct ClipboardListOptions {
    pub query: Option<String>,
    pub favorites_only: Option<bool>,
    pub kind: Option<String>,
    pub category_id: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[napi(object)]
pub struct ClipboardCategory {
    pub id: String,
    pub name: String,
    pub color: String,
}
impl From<xiaowei_clipboard::ClipboardCategory> for ClipboardCategory {
    fn from(value: xiaowei_clipboard::ClipboardCategory) -> Self {
        Self {
            id: value.id,
            name: value.name,
            color: value.color,
        }
    }
}

#[napi]
pub struct ClipboardHistory {
    service: Arc<Service>,
}

async fn run<T: Send + 'static>(
    work: impl FnOnce() -> xiaowei_clipboard::Result<T> + Send + 'static,
) -> napi::Result<T> {
    napi::tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| napi::Error::from_reason(error.to_string()))?
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

fn parse_id(id: &str) -> napi::Result<i64> {
    id.parse::<i64>()
        .ok()
        .filter(|value| *value > 0 && value.to_string() == id)
        .ok_or_else(|| napi::Error::from_reason("Invalid clipboard item ID"))
}

#[napi]
impl ClipboardHistory {
    #[napi(factory, ts_args_type = "directory: string, onChange: () => void")]
    pub async fn open(directory: String, on_change: Arc<ChangeCallback>) -> napi::Result<Self> {
        run(move || {
            let service = Service::open(std::path::Path::new(&directory), SystemClipboard, move || {
                // Invalidation is coalesced: a queued event makes the reader fetch the latest state.
                let _ = on_change.call((), ThreadsafeFunctionCallMode::NonBlocking);
            })?;
            Ok(Self {
                service: Arc::new(service),
            })
        })
        .await
    }

    #[napi]
    pub fn start_monitoring(&self) -> napi::Result<()> {
        if !cfg!(target_os = "macos") {
            return Err(napi::Error::from_reason("Clipboard monitoring requires macOS"));
        }
        self.service
            .start()
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    #[napi]
    pub fn stop_monitoring(&self) -> napi::Result<()> {
        self.service
            .stop()
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    #[napi]
    pub async fn list(&self, options: ClipboardListOptions) -> napi::Result<Vec<ClipboardItem>> {
        let service = Arc::clone(&self.service);
        run(move || {
            service
                .list(&xiaowei_clipboard::ListOptions {
                    query: options.query.unwrap_or_default(),
                    favorites_only: options.favorites_only.unwrap_or(false),
                    kind: options.kind,
                    category_id: options
                        .category_id
                        .map(|id| parse_id(&id).map(|id| id.to_string()))
                        .transpose()?,
                    limit: options.limit.unwrap_or(50),
                    offset: options.offset.unwrap_or(0),
                })
                .map(|items| items.into_iter().map(Into::into).collect())
        })
        .await
    }

    #[napi]
    pub async fn get(&self, id: String) -> napi::Result<Option<ClipboardItem>> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(move || service.get(id).map(|item| item.map(Into::into))).await
    }

    #[napi]
    pub async fn read_text(&self, id: String) -> napi::Result<String> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(move || match service.data(id)? {
            ClipboardData::Text(text) => Ok(text),
            _ => Err("Clipboard item is not text".into()),
        })
        .await
    }

    #[napi]
    pub async fn read_image(&self, id: String) -> napi::Result<napi::bindgen_prelude::Buffer> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(move || match service.data(id)? {
            ClipboardData::Image { data, .. } => Ok(data.into()),
            _ => Err("Clipboard item is not an image".into()),
        })
        .await
    }

    #[napi]
    pub async fn add_text(&self, text: String) -> napi::Result<ClipboardItem> {
        let service = Arc::clone(&self.service);
        run(move || service.add_text(text).map(Into::into)).await
    }

    #[napi]
    pub async fn copy(&self, id: String) -> napi::Result<()> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(move || service.copy(id)).await
    }

    #[napi]
    pub async fn set_favorite(&self, id: String, favorite: bool) -> napi::Result<bool> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(move || service.set_favorite(id, favorite)).await
    }

    #[napi]
    pub async fn categories(&self) -> napi::Result<Vec<ClipboardCategory>> {
        let service = Arc::clone(&self.service);
        run(move || {
            service
                .categories()
                .map(|items| items.into_iter().map(Into::into).collect())
        })
        .await
    }
    #[napi]
    pub async fn save_category(
        &self,
        name: String,
        color: String,
        id: Option<String>,
    ) -> napi::Result<ClipboardCategory> {
        let id = id.map(|id| parse_id(&id)).transpose()?;
        let service = Arc::clone(&self.service);
        run(move || service.save_category(id, &name, &color).map(Into::into)).await
    }
    #[napi]
    pub async fn delete_category(&self, id: String) -> napi::Result<()> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(move || service.delete_category(id)).await
    }
    #[napi]
    pub async fn set_remark(&self, id: String, remark: String) -> napi::Result<()> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(move || service.set_remark(id, &remark)).await
    }
    #[napi]
    pub async fn set_category(&self, id: String, category_id: Option<String>) -> napi::Result<()> {
        let id = parse_id(&id)?;
        let category = category_id.map(|id| parse_id(&id)).transpose()?;
        let service = Arc::clone(&self.service);
        run(move || service.set_category(id, category)).await
    }
    #[napi]
    pub async fn edit_text(&self, id: String, text: String) -> napi::Result<ClipboardItem> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(move || service.edit_text(id, text).map(Into::into)).await
    }

    #[napi]
    pub async fn delete(&self, id: String) -> napi::Result<bool> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(move || service.delete(id)).await
    }

    #[napi]
    pub async fn clear_history(&self) -> napi::Result<u32> {
        let service = Arc::clone(&self.service);
        run(move || service.clear_history().map(|count| count as u32)).await
    }
}
