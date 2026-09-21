use napi::bindgen_prelude::{Buffer, PromiseRaw};
use napi_derive::napi;
use std::sync::Arc;
use xw_gateway::napi::{reply, Callback, Endpoint, Reply};
use xw_gateway::XwInvokeRegistry;

#[napi]
pub struct GatewayEndpoint {
    pub(crate) inner: Arc<Endpoint>,
    service: Option<Arc<xiaowei_clipboard::Service>>,
    #[cfg(feature = "gateway-fixtures")]
    fixture: Option<Arc<xw_gateway::napi::fixture::Fixture>>,
}

#[napi]
pub fn create_gateway_endpoint(env: napi::Env) -> napi::Result<GatewayEndpoint> {
    let registry = XwInvokeRegistry::new();
    let owner = registry
        .register_owner("module", vec![], vec![])
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let inner = Endpoint::new(registry, owner);
    inner.install_cleanup(&env)?;
    Ok(GatewayEndpoint {
        service: None,
        inner,
        #[cfg(feature = "gateway-fixtures")]
        fixture: None,
    })
}

#[napi]
impl GatewayEndpoint {
    #[napi]
    pub fn manifest(&self) -> napi::Result<String> {
        self.inner
            .manifest()
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }
    #[napi(ts_args_type = "callback: (control: string, payload: Buffer) => Promise<Buffer | string>, context: string")]
    pub fn bind(&self, callback: Arc<Callback>, context: String) -> napi::Result<()> {
        self.inner
            .bind(callback, &context)
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }
    // Clone owned state before returning the promise. Keeping an async &self
    // borrow until environment teardown can release napi's borrow guard off-thread.
    #[napi(ts_return_type = "Promise<Buffer | string>")]
    pub fn activate<'env>(&self, env: &'env napi::Env) -> napi::Result<PromiseRaw<'env, Reply>> {
        let inner = self.inner.clone();
        env.spawn_future(async move { Ok(reply(inner.activate().await.map(|_| vec![]))) })
    }
    #[napi(ts_return_type = "Promise<Buffer | string>")]
    pub fn dispatch_local<'env>(
        &self,
        env: &'env napi::Env,
        route: String,
        payload: Buffer,
        context: String,
    ) -> napi::Result<PromiseRaw<'env, Reply>> {
        let inner = self.inner.clone();
        let payload = payload.to_vec();
        env.spawn_future(async move { Ok(reply(inner.dispatch_local(&route, payload, &context).await)) })
    }
    #[napi(ts_return_type = "Promise<Buffer | string>")]
    pub fn stream_control<'env>(
        &self,
        env: &'env napi::Env,
        control: String,
        payload: Buffer,
        context: String,
    ) -> napi::Result<PromiseRaw<'env, Reply>> {
        let prepared = self.inner.prepare_stream(&control, &context);
        let inner = self.inner.clone();
        let payload = payload.to_vec();
        env.spawn_future(async move {
            Ok(reply(match prepared {
                Ok(()) => inner.stream_control(&control, payload, &context).await,
                Err(error) => Err(error),
            }))
        })
    }
    #[napi(ts_return_type = "Promise<Buffer | string>")]
    pub fn subscribe_local<'env>(
        &self,
        env: &'env napi::Env,
        id: String,
        event: String,
        filter: Option<Buffer>,
        context: String,
    ) -> napi::Result<PromiseRaw<'env, Reply>> {
        let inner = self.inner.clone();
        let filter = filter.map(|v| v.to_vec());
        env.spawn_future(async move {
            Ok(reply(
                inner.subscribe_local(&id, &event, filter, &context).map(|_| vec![]),
            ))
        })
    }
    #[napi]
    pub fn unsubscribe_local(&self, id: String) {
        self.inner.unsubscribe_local(&id);
    }
    #[napi(ts_return_type = "Promise<Buffer | string>")]
    pub fn deliver<'env>(
        &self,
        env: &'env napi::Env,
        id: String,
        payload: Buffer,
    ) -> napi::Result<PromiseRaw<'env, Reply>> {
        let inner = self.inner.clone();
        let payload = payload.to_vec();
        env.spawn_future(async move { Ok(reply(inner.deliver(&id, payload))) })
    }
    #[napi(ts_return_type = "Promise<Buffer | string>")]
    pub fn close<'env>(&self, env: &'env napi::Env) -> napi::Result<PromiseRaw<'env, Reply>> {
        let inner = self.inner.clone();
        let service = self.service.clone();
        env.spawn_future(async move {
            if let Some(service) = service {
                service
                    .stop()
                    .await
                    .map_err(|error| napi::Error::from_reason(error.to_string()))?;
            }
            Ok(reply(inner.close().await))
        })
    }
}

#[cfg(feature = "gateway-fixtures")]
#[napi]
pub fn create_gateway_fixture(env: napi::Env) -> napi::Result<GatewayEndpoint> {
    let fixture = Arc::new(xw_gateway::napi::fixture::Fixture::new(true));
    fixture.endpoint.install_cleanup(&env)?;
    Ok(GatewayEndpoint {
        service: None,
        inner: fixture.endpoint.clone(),
        fixture: Some(fixture),
    })
}

#[cfg(feature = "gateway-fixtures")]
#[napi]
impl GatewayEndpoint {
    #[napi(ts_return_type = "Promise<Buffer | string>")]
    pub fn fixture_invoke<'env>(
        &self,
        env: &'env napi::Env,
        route: String,
        payload: Buffer,
    ) -> napi::Result<PromiseRaw<'env, Reply>> {
        let inner = self.inner.clone();
        let payload = payload.to_vec();
        env.spawn_future(async move { Ok(reply(inner.invoke(&route, payload).await)) })
    }
    #[napi]
    pub fn fixture_stream_usage(&self) -> String {
        self.fixture.as_ref().unwrap().stream_usage()
    }
    #[napi]
    pub fn fixture_release(&self) {
        self.fixture.as_ref().unwrap().release();
    }
    #[napi(ts_return_type = "Promise<Buffer | string>")]
    pub fn fixture_publish<'env>(
        &self,
        env: &'env napi::Env,
        payload: Buffer,
    ) -> napi::Result<PromiseRaw<'env, Reply>> {
        let fixture = self.fixture.as_ref().unwrap().clone();
        let payload = payload.to_vec();
        env.spawn_future(async move { Ok(reply(fixture.publish(payload))) })
    }
    #[napi(ts_return_type = "Promise<Buffer | string>")]
    pub fn fixture_subscribe<'env>(
        &self,
        env: &'env napi::Env,
        filter: Option<Buffer>,
    ) -> napi::Result<PromiseRaw<'env, Reply>> {
        let fixture = self.fixture.as_ref().unwrap().clone();
        let filter = filter.map(|v| v.to_vec());
        env.spawn_future(async move { Ok(reply(fixture.subscribe(filter).await)) })
    }
    #[napi]
    pub fn fixture_unsubscribe(&self) {
        self.fixture.as_ref().unwrap().unsubscribe();
    }
    #[napi(ts_return_type = "Promise<Buffer | string>")]
    pub fn fixture_next<'env>(&self, env: &'env napi::Env) -> napi::Result<PromiseRaw<'env, Reply>> {
        let fixture = self.fixture.as_ref().unwrap().clone();
        env.spawn_future(async move { Ok(reply(fixture.next().await)) })
    }
}

pub(crate) fn business_endpoint(
    env: &napi::Env,
    service: Arc<xiaowei_clipboard::Service>,
    registry: Arc<XwInvokeRegistry>,
) -> napi::Result<(GatewayEndpoint, Arc<XwInvokeRegistry>, xw_gateway::invoke::Owner)> {
    let owner = registry
        .register_owner(
            "clipboard",
            xiaowei_clipboard::gateway::registrations(&service),
            xiaowei_clipboard::gateway::events(),
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let inner = Endpoint::new(registry.clone(), owner.clone());
    inner.install_cleanup(env)?;
    Ok((
        GatewayEndpoint {
            service: Some(service),
            inner,
            #[cfg(feature = "gateway-fixtures")]
            fixture: None,
        },
        registry,
        owner,
    ))
}
