use napi_derive::napi;
use std::sync::Arc;
use xiaowei_storage::Database;

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
        gateway::create_key_value_endpoint(&self.database, env)
    }

    #[napi]
    pub fn create_clipboard_dao_gateway_endpoint(&self, env: napi::Env) -> napi::Result<GatewayEndpoint> {
        gateway::create_clipboard_dao_endpoint(&self.database, env)
    }

    #[napi]
    pub fn create_settings_gateway_endpoint(&self, env: napi::Env, platform: String) -> napi::Result<GatewayEndpoint> {
        gateway::create_settings_endpoint(&self.database, env, platform)
    }
}
