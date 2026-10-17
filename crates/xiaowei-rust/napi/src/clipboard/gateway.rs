pub use crate::gateway::GatewayEndpoint;
use crate::gateway::Resources;
use std::sync::Arc;
use xw_gateway::{napi::Endpoint, XwInvokeRegistry};

pub(crate) fn business_endpoint(
    env: &napi::Env,
    service: Arc<xw_clipboard::Service>,
    registry: Arc<XwInvokeRegistry>,
) -> napi::Result<(
    GatewayEndpoint,
    Arc<XwInvokeRegistry>,
    xw_gateway::invoke::Owner,
)> {
    let owner = registry
        .register_owner(
            "clipboard",
            xw_clipboard::gateway::registrations(&service),
            xw_clipboard::gateway::events(),
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let inner = Endpoint::new(registry.clone(), owner.clone());
    Ok((
        GatewayEndpoint::new(env, inner, Resources::Clipboard(service))?,
        registry,
        owner,
    ))
}
