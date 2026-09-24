use super::{SettingsError, SettingsService};
use std::sync::Arc;
use xw_contracts::xiaowei::{common::Empty, storage::SettingsChanged};
use xw_gateway::{
    event::{EventBackpressure, EventExportRegistration},
    ErrorCode, GatewayError, InvokeRegistration,
};

use crate::gateway_binding::xiaowei_storage_settings_service as methods;

tokio::task_local! {
    pub(super) static CALLER: xw_gateway::invoke::Client;
}

pub(super) async fn apply(
    previous: xw_contracts::xiaowei::storage::SettingsSnapshot,
    next: xw_contracts::xiaowei::storage::SettingsSnapshot,
) -> Result<(), String> {
    use crate::gateway_binding::{
        xiaowei_shortcuts_shortcuts_service as shortcuts, xiaowei_system_system_service as system,
    };
    let client = CALLER
        .try_with(Clone::clone)
        .map_err(|_| "Settings update requires a Gateway caller".to_owned())?;
    if previous.shortcuts != next.shortcuts {
        shortcuts::APPLY
            .call(&client, next.shortcuts.unwrap_or_default())
            .await
            .map_err(|error| error.to_string())?;
    }
    if previous.autostart != next.autostart {
        system::SET_AUTOSTART
            .call(
                &client,
                xw_contracts::xiaowei::system::SetAutostartRequest {
                    enabled: next.autostart,
                },
            )
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn registrations(service: &Arc<SettingsService>) -> Vec<InvokeRegistration> {
    let get = service.clone();
    let update = service.clone();
    vec![
        methods::GET.handler(move |_, _| {
            let service = get.clone();
            async move {
                service
                    .get()
                    .await
                    .map_err(|error| GatewayError::new(ErrorCode::HandlerError, error))
            }
        }),
        methods::UPDATE.handler(move |request, client| {
            let service = update.clone();
            async move {
                CALLER
                    .scope(client, service.update(request))
                    .await
                    .map_err(|error| match error {
                        SettingsError::InvalidArgument(_) => {
                            GatewayError::new(ErrorCode::InvalidArgument, error.to_string())
                        }
                        SettingsError::Operation(_) => GatewayError::new(ErrorCode::HandlerError, error.to_string()),
                    })
            }
        }),
    ]
}

pub fn events() -> Vec<EventExportRegistration> {
    vec![EventExportRegistration::typed::<SettingsChanged, Empty, _>(
        EventBackpressure::Coalesce,
        |_, _| true,
    )]
}
