use super::{SettingsError, SettingsService};
use proto_desktop_rs::xiaowei::desktop::SettingsChanged;
use std::sync::Arc;
use xw_gateway::{
    event::{EventBackpressure, EventExportRegistration},
    ErrorCode, GatewayError, InvokeRegistration,
};

use crate::gateway_binding::xiaowei_desktop_settings_service as methods;

tokio::task_local! {
    pub(super) static CALLER: xw_gateway::invoke::Client;
}

pub(super) async fn apply(
    previous: proto_desktop_rs::xiaowei::desktop::SettingsSnapshot,
    next: proto_desktop_rs::xiaowei::desktop::SettingsSnapshot,
) -> Result<(), String> {
    use crate::gateway_binding::{
        xiaowei_desktop_shortcuts_service as shortcuts, xiaowei_desktop_system_service as system,
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
                proto_desktop_rs::xiaowei::desktop::SetAutostartRequest {
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
    let runtime = service.clone();
    vec![
        methods::GET_WEB_SEARCH_RUNTIME_CONFIG.handler(move |request, client| {
            let service = runtime.clone();
            async move {
                // Electron assigns frame identities; business payloads cannot override them.
                if client.context().caller().starts_with("frame:") {
                    return Err(GatewayError::new(
                        ErrorCode::Unauthorized,
                        "Agent assembly required",
                    ));
                }
                service
                    .web_search_runtime_config(request)
                    .await
                    .map_err(|error| match error {
                        SettingsError::InvalidArgument(_) => {
                            GatewayError::new(ErrorCode::InvalidArgument, error.to_string())
                        }
                        SettingsError::Operation(_) => {
                            GatewayError::new(ErrorCode::HandlerError, error.to_string())
                        }
                    })
            }
        }),
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
                        SettingsError::Operation(_) => {
                            GatewayError::new(ErrorCode::HandlerError, error.to_string())
                        }
                    })
            }
        }),
    ]
}

pub fn events() -> Vec<EventExportRegistration> {
    vec![EventExportRegistration::typed::<SettingsChanged, (), _>(
        EventBackpressure::Coalesce,
        |_, _| true,
    )]
}
