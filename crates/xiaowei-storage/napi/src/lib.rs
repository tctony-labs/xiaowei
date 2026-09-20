use napi_derive::napi;
use std::sync::Arc;
use xiaowei_storage::Database;
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
    pub fn create_gateway_endpoint(&self, env: napi::Env) -> napi::Result<GatewayEndpoint> {
        let registry = XwInvokeRegistry::new();
        let owner = registry
            .register_owner(
                "storage",
                xiaowei_storage::gateway::registrations(&self.database),
                vec![],
            )
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let inner = Endpoint::new(registry, owner);
        inner.install_cleanup(&env)?;
        Ok(GatewayEndpoint {
            inner,
            database: self.database.clone(),
        })
    }
}
