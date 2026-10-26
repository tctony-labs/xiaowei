//! Swift and Kotlin adapters for the mobile Rust entry point.
mod types;

use std::sync::Arc;
pub use types::*;
use xiaowei_mobile as mobile;

type Result<T> = std::result::Result<T, MobileError>;

#[derive(uniffi::Object)]
pub struct MobileClient {
    inner: Arc<mobile::MobileClient>,
}

#[uniffi::export]
impl MobileClient {
    #[uniffi::constructor]
    pub fn new() -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            inner: mobile::MobileClient::new()?,
        }))
    }

    pub async fn set_session(&self, context: SessionContext) -> Result<i64> {
        Ok(self.inner.set_session(context.into()).await?)
    }

    pub fn login(
        &self,
        context: SessionContext,
        request: Vec<u8>,
    ) -> Result<Arc<AccountOperation>> {
        Ok(Arc::new(AccountOperation {
            inner: self.inner.login(context.into(), request)?,
        }))
    }

    pub fn restore(&self, context: SessionContext, force: bool) -> Result<Arc<AccountOperation>> {
        Ok(Arc::new(AccountOperation {
            inner: self.inner.restore(context.into(), force)?,
        }))
    }

    pub fn maintain(&self, context: SessionContext, force: bool) -> Result<Arc<AccountOperation>> {
        Ok(Arc::new(AccountOperation {
            inner: self.inner.maintain(context.into(), force)?,
        }))
    }

    pub fn logout(&self, context: SessionContext) -> Result<Arc<AccountOperation>> {
        Ok(Arc::new(AccountOperation {
            inner: self.inner.logout(context.into())?,
        }))
    }

    pub fn revoke(&self, context: SessionContext) -> Result<Arc<AccountOperation>> {
        Ok(Arc::new(AccountOperation {
            inner: self.inner.revoke(context.into())?,
        }))
    }

    pub fn invoke(
        &self,
        context: SessionContext,
        method: String,
        payload: Vec<u8>,
        options: RequestOptions,
    ) -> Result<Arc<ApiCall>> {
        Ok(Arc::new(ApiCall {
            inner: self
                .inner
                .invoke(context.into(), method, payload, options.into())?,
        }))
    }

    pub fn subscribe_connection(&self) -> Result<Arc<ConnectionSubscription>> {
        Ok(Arc::new(ConnectionSubscription {
            inner: self.inner.subscribe_connection()?,
        }))
    }

    pub async fn pause(&self) -> Result<()> {
        Ok(self.inner.suspend().await?)
    }

    pub async fn shutdown(&self) -> Result<()> {
        Ok(self.inner.close().await?)
    }
}

#[derive(uniffi::Object)]
pub struct AccountOperation {
    inner: Arc<mobile::AccountOperation>,
}

#[uniffi::export]
impl AccountOperation {
    pub async fn run(&self) -> Result<AccountOutcome> {
        Ok(self.inner.run().await?.into())
    }

    pub async fn resume(&self, credential_version: u64) -> Result<AccountOutcome> {
        Ok(self.inner.resume(credential_version).await?.into())
    }

    pub fn cancel(&self) {
        self.inner.cancel();
    }

    pub async fn settled_result(&self) -> Result<AccountOutcome> {
        Ok(self.inner.settled_result().await?.into())
    }

    pub async fn shutdown(&self) -> Result<()> {
        Ok(self.inner.close().await?)
    }
}

#[derive(uniffi::Object)]
pub struct ApiCall {
    inner: Arc<mobile::ApiCall>,
}

#[uniffi::export]
impl ApiCall {
    pub async fn run(&self) -> Result<Vec<u8>> {
        Ok(self.inner.run().await?)
    }

    pub fn cancel(&self) {
        self.inner.cancel();
    }

    pub async fn shutdown(&self) {
        self.inner.close().await;
    }
}

#[derive(uniffi::Object)]
pub struct ConnectionSubscription {
    inner: Arc<mobile::ConnectionSubscription>,
}

#[uniffi::export]
impl ConnectionSubscription {
    pub async fn next(&self) -> Result<Option<ConnectionSnapshot>> {
        Ok(self.inner.next().await?.map(Into::into))
    }

    pub fn stop(&self) {
        self.inner.close();
    }
}

uniffi::setup_scaffolding!();
