use crate::gateway::{GatewayEndpoint, Resources};
use prost::{Message, Name};
use proto_desktop_rs::xiaowei::desktop as pb;
use proto_server_rs::xiaowei::server::BaseResponse;
use std::sync::Arc;
use xw_gateway::napi::Endpoint;
use xw_gateway::{
    binding::Method,
    event::{EventBackpressure, EventExportRegistration},
    invoke::Owner,
    InvokeRegistration, XwInvokeRegistry,
};

use crate::account::Service;
use crate::gateway_binding::{
    xiaowei_server_auth_service as auth, xiaowei_server_health_service as health,
};

pub(crate) fn create(service: &Arc<Service>, env: &napi::Env) -> napi::Result<GatewayEndpoint> {
    let registry = XwInvokeRegistry::new();
    let owner = registry
        .register_owner(
            "server-api",
            registrations(service),
            vec![connection_event()],
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    observe_connection(service, &registry, &owner);
    GatewayEndpoint::new(
        env,
        Endpoint::new(registry, owner),
        Resources::Account(service.clone()),
    )
}

pub(crate) fn registrations(service: &Arc<Service>) -> Vec<InvokeRegistration> {
    vec![
        handler(service, &auth::LOGIN),
        handler(service, &auth::REFRESH),
        handler(service, &auth::GET_CURRENT_USER),
        handler(service, &auth::LOGOUT),
        handler(service, &health::CHECK),
        handler(service, &health::READY),
    ]
}

fn handler<Req, Res>(service: &Arc<Service>, method: &Method<Req, Res>) -> InvokeRegistration
where
    Req: Message + Default + Name + 'static,
    Res: Message + Default + Name + 'static,
{
    let service = service.clone();
    let name = method.name;
    method.handler(move |request, caller| {
        let service = service.clone();
        async move {
            let context = service.api_context(caller.context().transport_token())?;
            let bytes = request.encode_to_vec();
            let work = service.api.invoke(name, &bytes, &context);
            let cancellation = caller.cancellation();
            let result = tokio::select! {
                biased;
                _ = service.closed.cancelled() => Err(xw_api::Error::cancelled()),
                _ = cancellation.cancelled() => Err(xw_api::Error::cancelled()),
                result = work => result,
            };
            let bytes = match result {
                Ok(bytes) => bytes,
                Err(error) => BaseResponse {
                    code: error.code,
                    msg: error.message,
                    data: None,
                }
                .encode_to_vec(),
            };
            Res::decode(bytes.as_slice()).map_err(|_| {
                xw_gateway::GatewayError::new(
                    xw_gateway::ErrorCode::HandlerError,
                    "invalid xwapi response protobuf",
                )
            })
        }
    })
}

fn authentication(value: xw_api::connection::Authentication) -> i32 {
    use xw_api::connection::Authentication as A;
    match value {
        A::Authenticated => pb::ConnectionAuthentication::Authenticated as i32,
        A::Rejected => pb::ConnectionAuthentication::Rejected as i32,
        A::Unavailable => pb::ConnectionAuthentication::Unavailable as i32,
    }
}

pub(crate) fn connection_event() -> EventExportRegistration {
    EventExportRegistration::typed::<pb::ConnectionChanged, (), _>(
        EventBackpressure::Ordered,
        |_, _| true,
    )
}

pub(crate) fn observe_connection(
    service: &Arc<Service>,
    registry: &Arc<XwInvokeRegistry>,
    owner: &Owner,
) {
    let weak = Arc::downgrade(registry);
    let publisher = owner.clone();
    let cancel = service.closed.clone();
    let mut updates = service.api.connection.subscribe();
    napi::bindgen_prelude::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return,
                result = updates.changed() => { if result.is_err() { return; } }
            }
            let snapshot = updates.borrow_and_update().clone();
            let Some(registry) = weak.upgrade() else {
                return;
            };
            let status = match snapshot.status {
                xw_api::connection::Status::Disconnected => pb::ConnectionStatus::Disconnected,
                xw_api::connection::Status::Connecting => pb::ConnectionStatus::Connecting,
                xw_api::connection::Status::Connected => pb::ConnectionStatus::Connected,
                xw_api::connection::Status::Reconnecting => pb::ConnectionStatus::Reconnecting,
            };
            let change = pb::ConnectionChanged {
                generation: snapshot.generation,
                status: status as i32,
                authentication: snapshot
                    .authentication
                    .map(authentication)
                    .unwrap_or_default(),
            };
            let _ = registry.publish(
                &publisher,
                &pb::ConnectionChanged::full_name(),
                change.encode_to_vec(),
            );
        }
    });
}
