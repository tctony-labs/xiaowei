pub use crate::gateway::GatewayEndpoint;
use crate::gateway::Resources;
use prost::{Message, Name};
use std::sync::Arc;
use xw_gateway::{napi::Endpoint, XwInvokeRegistry};
use xw_storage::{clipboard_dao::ClipboardDao, settings::SettingsService, Database};

pub(crate) fn create_key_value_endpoint(
    database: &Arc<Database>,
    env: napi::Env,
) -> napi::Result<GatewayEndpoint> {
    let registry = XwInvokeRegistry::new();
    let owner = registry
        .register_owner(
            "key-value",
            xw_storage::gateway::registrations(database),
            vec![],
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let inner = Endpoint::new(registry, owner);
    GatewayEndpoint::new(
        &env,
        inner,
        Resources::Storage {
            database: database.clone(),
            close_database: true,
        },
    )
}

pub(crate) fn create_clipboard_dao_endpoint(
    database: &Arc<Database>,
    env: napi::Env,
) -> napi::Result<GatewayEndpoint> {
    let dao = Arc::new(ClipboardDao::new(database.clone()));
    let registry = XwInvokeRegistry::new();
    let owner = registry
        .register_owner(
            "clipboard-dao",
            xw_storage::clipboard_dao::gateway::registrations(&dao),
            vec![],
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let inner = Endpoint::new(registry, owner);
    GatewayEndpoint::new(
        &env,
        inner,
        Resources::Storage {
            database: database.clone(),
            close_database: false,
        },
    )
}

pub(crate) fn create_settings_endpoint(
    database: &Arc<Database>,
    env: napi::Env,
    platform: String,
) -> napi::Result<GatewayEndpoint> {
    let service = Arc::new(SettingsService::new(database.clone(), platform));
    let registry = XwInvokeRegistry::new();
    let owner = registry
        .register_owner(
            "settings",
            xw_storage::settings::gateway::registrations(&service),
            xw_storage::settings::gateway::events(),
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let publisher = Arc::downgrade(&registry);
    let publisher_owner = owner.clone();
    service.set_publisher(Arc::new(move |change| {
        if let Some(registry) = publisher.upgrade() {
            let _ = registry.publish(
                &publisher_owner,
                &proto_desktop_rs::xiaowei::desktop::settings::SettingsChanged::full_name(),
                change.encode_to_vec(),
            );
        }
    }));
    let inner = Endpoint::new(registry, owner);
    GatewayEndpoint::new(
        &env,
        inner,
        Resources::Storage {
            database: database.clone(),
            close_database: false,
        },
    )
}
