use napi::bindgen_prelude::{Buffer, PromiseRaw};
use napi_derive::napi;
use std::sync::Arc;
use xiaowei_storage::Database;
use xw_gateway::napi::{reply, Callback, Endpoint, Reply};

#[napi]
pub struct GatewayEndpoint {
    pub(crate) inner: Arc<Endpoint>,
    pub(crate) database: Arc<Database>,
    pub(crate) close_database: bool,
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
        let database = self.database.clone();
        let close_database = self.close_database;
        env.spawn_future(async move {
            let result = inner.close().await;
            if close_database {
                database.close().await;
            }
            Ok(reply(result))
        })
    }
}
