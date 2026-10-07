use std::sync::{Arc, Mutex, Weak};

use napi::bindgen_prelude::PromiseRaw;
use napi_derive::napi;
use xw_gateway::napi::Endpoint;

mod gateway;
pub mod logging;

#[napi]
pub struct Agent {
    inner: Arc<xiaowei_agent::Agent>,
    endpoint: Mutex<Option<Weak<Endpoint>>>,
}

#[napi]
impl Agent {
    #[napi(factory)]
    pub fn create() -> Self {
        Self {
            inner: xiaowei_agent::Agent::new(),
            endpoint: Mutex::new(None),
        }
    }

    #[napi(factory)]
    pub async fn open(root: String) -> napi::Result<Self> {
        let inner = xiaowei_agent::Agent::open(root.into())
            .await
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        Ok(Self {
            inner,
            endpoint: Mutex::new(None),
        })
    }

    #[napi]
    pub fn create_gateway_endpoint(&self, env: napi::Env) -> napi::Result<gateway::GatewayEndpoint> {
        let mut current = self.endpoint.lock().unwrap();
        if current.as_ref().and_then(Weak::upgrade).is_some() {
            return Err(napi::Error::from_reason("Agent endpoint already created"));
        }
        let endpoint = gateway::create_endpoint(&self.inner, env)?;
        *current = Some(Arc::downgrade(&endpoint.inner));
        Ok(endpoint)
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn close<'env>(&self, env: &'env napi::Env) -> napi::Result<PromiseRaw<'env, ()>> {
        let agent = self.inner.clone();
        let endpoint = self.endpoint.lock().unwrap().as_ref().and_then(Weak::upgrade);
        env.spawn_future(async move {
            let service = agent.close().await;
            if let Some(endpoint) = endpoint {
                endpoint
                    .close()
                    .await
                    .map_err(|error| napi::Error::from_reason(error.to_string()))?;
            }
            service.map_err(|error| napi::Error::from_reason(error.to_string()))
        })
    }
}
