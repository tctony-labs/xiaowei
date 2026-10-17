pub use crate::gateway::GatewayEndpoint;
use crate::gateway::Resources;
use napi_derive::napi;
use xw_gateway::{napi::Endpoint, XwInvokeRegistry};

#[napi]
pub fn create_search_gateway_endpoint(
    env: napi::Env,
    development: Option<bool>,
) -> napi::Result<GatewayEndpoint> {
    let registry = XwInvokeRegistry::new();
    let owner = registry
        .register_owner(
            "search",
            xw_search::gateway::registrations(
                crate::search::service(),
                development.unwrap_or(false),
            ),
            vec![],
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let inner = Endpoint::new(registry, owner);
    GatewayEndpoint::new(&env, inner, Resources::None)
}
