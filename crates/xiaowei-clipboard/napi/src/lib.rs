use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::{Arc, Mutex, Weak};
use xiaowei_clipboard::{ClipboardData, Service, SystemClipboard};
use xw_gateway::{invoke::Owner, XwInvokeRegistry};

pub mod gateway;
pub mod logging;
mod paste;
pub use paste::{request_accessibility_permission, send_paste_shortcut};

type ChangeCallback = ThreadsafeFunction<(), (), (), napi::Status, false, true, 1>;

#[napi(object)]
pub struct ClipboardItem {
    pub id: String,
    pub kind: String,
    pub image_path: Option<String>,
    pub text_path: Option<String>,
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
            text_path: item.text_path,
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
    endpoint: Mutex<Option<Weak<xw_gateway::napi::Endpoint>>>,
    registry: Arc<XwInvokeRegistry>,
    service: Arc<Service>,
    gateways: Arc<Mutex<Vec<(Weak<XwInvokeRegistry>, Owner)>>>,
}

async fn run<T>(work: impl std::future::Future<Output = xiaowei_clipboard::Result<T>>) -> napi::Result<T> {
    work.await.map_err(|error| napi::Error::from_reason(error.to_string()))
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
        run(async move {
            let registry = XwInvokeRegistry::new();
            let client = registry.client(xw_gateway::CallContext::trusted("clipboard"));
            let gateways = Arc::new(Mutex::new(Vec::<(Weak<XwInvokeRegistry>, Owner)>::new()));
            let publishers = gateways.clone();
            let service = Service::open(std::path::Path::new(&directory), client, SystemClipboard, move || {
                publishers.lock().unwrap().retain(|(registry, owner)| {
                    if owner.is_closed() {
                        return false;
                    }
                    if let Some(registry) = registry.upgrade() {
                        let _ = registry.publish(
                            owner,
                            <xw_contracts::xiaowei::clipboard::ClipboardChanged as prost::Name>::full_name().as_str(),
                            vec![],
                        );
                        true
                    } else {
                        false
                    }
                });
                // Invalidation is coalesced: a queued event makes the reader fetch the latest state.
                let _ = on_change.call((), ThreadsafeFunctionCallMode::NonBlocking);
            })?;
            Ok(Self {
                endpoint: Mutex::new(None),
                registry,
                service: Arc::new(service),
                gateways,
            })
        })
        .await
    }

    #[napi]
    pub fn create_gateway_endpoint(&self, env: napi::Env) -> napi::Result<gateway::GatewayEndpoint> {
        let (endpoint, registry, owner) =
            gateway::business_endpoint(&env, self.service.clone(), self.registry.clone())?;
        self.gateways.lock().unwrap().push((Arc::downgrade(&registry), owner));
        *self.endpoint.lock().unwrap() = Some(Arc::downgrade(&endpoint.inner));
        Ok(endpoint)
    }

    #[napi]
    pub async fn initialize(&self) -> napi::Result<()> {
        let service = self.service.clone();
        let endpoint = self
            .endpoint
            .lock()
            .unwrap()
            .as_ref()
            .and_then(Weak::upgrade)
            .ok_or_else(|| napi::Error::from_reason("Create and attach the Gateway endpoint before initializing"))?;
        let client = endpoint
            .client()
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        run(async move { service.initialize_with_client(client).await }).await
    }

    #[napi]
    pub async fn start_monitoring(&self) -> napi::Result<()> {
        if !cfg!(target_os = "macos") {
            return Err(napi::Error::from_reason("Clipboard monitoring requires macOS"));
        }
        self.service
            .start()
            .await
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    #[napi]
    pub async fn stop_monitoring(&self) -> napi::Result<()> {
        self.service
            .stop()
            .await
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    #[napi]
    pub async fn list(&self, options: ClipboardListOptions) -> napi::Result<Vec<ClipboardItem>> {
        let service = Arc::clone(&self.service);
        run(async move {
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
                .await
                .map(|items| items.into_iter().map(Into::into).collect())
        })
        .await
    }

    #[napi]
    pub async fn get(&self, id: String) -> napi::Result<Option<ClipboardItem>> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(async move { service.get(id).await.map(|item| item.map(Into::into)) }).await
    }

    #[napi]
    pub async fn read_text(&self, id: String) -> napi::Result<String> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(async move {
            match service.data(id).await? {
                ClipboardData::Text(text) => Ok(text),
                _ => Err("Clipboard item is not text".into()),
            }
        })
        .await
    }

    #[napi]
    pub async fn read_image(&self, id: String) -> napi::Result<napi::bindgen_prelude::Buffer> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(async move {
            match service.data(id).await? {
                ClipboardData::Image { data, .. } => Ok(data.into()),
                _ => Err("Clipboard item is not an image".into()),
            }
        })
        .await
    }

    #[napi]
    pub async fn add_text(&self, text: String) -> napi::Result<ClipboardItem> {
        let service = Arc::clone(&self.service);
        run(async move { service.add_text(text).await.map(Into::into) }).await
    }

    #[napi]
    pub async fn copy(&self, id: String) -> napi::Result<()> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(async move { service.copy(id).await }).await
    }

    #[napi]
    pub async fn set_favorite(&self, id: String, favorite: bool) -> napi::Result<bool> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(async move { service.set_favorite(id, favorite).await }).await
    }

    #[napi]
    pub async fn categories(&self) -> napi::Result<Vec<ClipboardCategory>> {
        let service = Arc::clone(&self.service);
        run(async move {
            service
                .categories()
                .await
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
        run(async move { service.save_category(id, &name, &color).await.map(Into::into) }).await
    }
    #[napi]
    pub async fn delete_category(&self, id: String) -> napi::Result<()> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(async move { service.delete_category(id).await }).await
    }
    #[napi]
    pub async fn set_remark(&self, id: String, remark: String) -> napi::Result<()> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(async move { service.set_remark(id, &remark).await }).await
    }
    #[napi]
    pub async fn set_category(&self, id: String, category_id: Option<String>) -> napi::Result<()> {
        let id = parse_id(&id)?;
        let category = category_id.map(|id| parse_id(&id)).transpose()?;
        let service = Arc::clone(&self.service);
        run(async move { service.set_category(id, category).await }).await
    }
    #[napi]
    pub async fn edit_text(&self, id: String, text: String) -> napi::Result<ClipboardItem> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(async move { service.edit_text(id, text).await.map(Into::into) }).await
    }

    #[napi]
    pub async fn delete(&self, id: String) -> napi::Result<bool> {
        let id = parse_id(&id)?;
        let service = Arc::clone(&self.service);
        run(async move { service.delete(id).await }).await
    }

    #[napi]
    pub async fn clear_history(&self) -> napi::Result<u32> {
        let service = Arc::clone(&self.service);
        run(async move { service.clear_history().await.map(|count| count as u32) }).await
    }
}
