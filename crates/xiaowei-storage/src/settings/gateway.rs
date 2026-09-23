use super::{SettingsError, SettingsService};
use std::sync::Arc;
use xw_contracts::xiaowei::{common::Empty, storage::SettingsChanged};
use xw_gateway::{
    event::{EventBackpressure, EventExportRegistration},
    ErrorCode, GatewayError, InvokeRegistration,
};

use crate::gateway_binding::xiaowei_storage_settings_service as methods;

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
        methods::UPDATE.handler(move |request, _| {
            let service = update.clone();
            async move {
                service.update(request).await.map_err(|error| match error {
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
