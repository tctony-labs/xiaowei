use napi_derive::napi;
use prost::{Message, Name};
use std::sync::Arc;
use xiaowei_storage::{clipboard_dao::ClipboardDao, settings::SettingsService, Database};
use xw_gateway::{napi::Endpoint, XwInvokeRegistry};

mod gateway;
use gateway::GatewayEndpoint;

#[napi]
pub struct Storage {
    database: Arc<Database>,
}

#[napi]
impl Storage {
    #[napi(factory)]
    pub async fn open(path: String) -> napi::Result<Self> {
        let database = Database::open(std::path::Path::new(&path))
            .await
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        Ok(Self {
            database: Arc::new(database),
        })
    }

    #[napi]
    pub fn create_key_value_gateway_endpoint(&self, env: napi::Env) -> napi::Result<GatewayEndpoint> {
        let registry = XwInvokeRegistry::new();
        let owner = registry
            .register_owner(
                "key-value",
                xiaowei_storage::gateway::registrations(&self.database),
                vec![],
            )
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let inner = Endpoint::new(registry, owner);
        inner.install_cleanup(&env)?;
        Ok(GatewayEndpoint {
            inner,
            database: self.database.clone(),
            close_database: true,
        })
    }

    #[napi]
    pub fn create_clipboard_dao_gateway_endpoint(&self, env: napi::Env) -> napi::Result<GatewayEndpoint> {
        let dao = Arc::new(ClipboardDao::new(self.database.clone()));
        let registry = XwInvokeRegistry::new();
        let owner = registry
            .register_owner(
                "clipboard-dao",
                xiaowei_storage::clipboard_dao_gateway::registrations(&dao),
                vec![],
            )
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let inner = Endpoint::new(registry, owner);
        inner.install_cleanup(&env)?;
        Ok(GatewayEndpoint {
            inner,
            database: self.database.clone(),
            close_database: false,
        })
    }

    #[napi]
    pub fn create_settings_gateway_endpoint(&self, env: napi::Env, platform: String) -> napi::Result<GatewayEndpoint> {
        let service = Arc::new(SettingsService::new(self.database.clone(), platform));
        let registry = XwInvokeRegistry::new();
        let owner = registry
            .register_owner(
                "settings",
                xiaowei_storage::settings::gateway::registrations(&service),
                xiaowei_storage::settings::gateway::events(),
            )
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let publisher = Arc::downgrade(&registry);
        let publisher_owner = owner.clone();
        service.set_publisher(Arc::new(move |change| {
            if let Some(registry) = publisher.upgrade() {
                let _ = registry.publish(
                    &publisher_owner,
                    &xw_contracts::xiaowei::storage::SettingsChanged::full_name(),
                    change.encode_to_vec(),
                );
            }
        }));
        let inner = Endpoint::new(registry, owner);
        inner.install_cleanup(&env)?;
        Ok(GatewayEndpoint {
            inner,
            database: self.database.clone(),
            close_database: false,
        })
    }
}
