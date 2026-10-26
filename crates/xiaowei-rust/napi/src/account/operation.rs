use napi::bindgen_prelude::{BigInt, Buffer, PromiseRaw};
use napi_derive::napi;
use prost::Message;
use std::sync::Arc;
use xw_api::account::{Access, Operation, Outcome};

use super::{HostSession, HostedOperation, Service};

#[napi(object)]
pub struct AccountOperationContext {
    pub operation_id: String,
    pub server: String,
    pub session_server: Option<String>,
    pub authenticated: Option<Buffer>,
    pub connect: bool,
    pub now_ms: i64,
}

impl From<AccountOperationContext> for HostSession {
    fn from(value: AccountOperationContext) -> Self {
        Self {
            operation_id: value.operation_id,
            server: value.server,
            session_server: value.session_server,
            authenticated: value.authenticated.map(|bytes| bytes.to_vec()),
            connect: value.connect,
            now_ms: value.now_ms,
        }
    }
}

#[napi(object)]
pub struct AccountOperationAccess {
    pub login: bool,
    pub refresh: bool,
    pub current_user: bool,
    pub logout: bool,
}

impl From<AccountOperationAccess> for Access {
    fn from(value: AccountOperationAccess) -> Self {
        Self {
            login: value.login,
            refresh: value.refresh,
            current_user: value.current_user,
            logout: value.logout,
        }
    }
}

#[napi(object)]
pub struct AccountOperationResult {
    pub code: i32,
    pub msg: String,
    pub authenticated: Option<Buffer>,
    pub credential_version: BigInt,
    pub checkpoint: bool,
    pub next_maintenance_at_ms: i64,
}

impl From<Outcome> for AccountOperationResult {
    fn from(value: Outcome) -> Self {
        Self {
            code: value.code,
            msg: value.message,
            authenticated: value
                .session
                .map(|session| Buffer::from(session.authenticated.encode_to_vec())),
            credential_version: BigInt::from(value.credential_version),
            checkpoint: value.checkpoint,
            next_maintenance_at_ms: value.next_maintenance_at_ms,
        }
    }
}

pub(super) fn start<'env>(
    env: &'env napi::Env,
    service: Arc<Service>,
    input: AccountOperationContext,
    operation: Operation,
    access: AccountOperationAccess,
) -> napi::Result<PromiseRaw<'env, AccountOperationResult>> {
    let host = HostSession::from(input);
    let pending = napi::bindgen_prelude::within_runtime_if_available(|| service.operation(&host))
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    // Register the cancellation token synchronously, before returning the JS promise.
    // An immediate AbortSignal must also cancel a Tokio task that has not started yet.
    env.spawn_future(async move {
        let work = pending.core.start(
            host.operation_id,
            operation,
            host.now_ms,
            access.into(),
            pending.cancel.clone(),
        );
        tokio::pin!(work);
        let outcome = tokio::select! {
            biased;
            _ = service.closed.cancelled() => {
                pending.cancel.cancel();
                work.await
            }
            outcome = &mut work => outcome,
        };
        Ok(outcome.into())
    })
}

fn pending(service: &Service, id: &str) -> napi::Result<Arc<HostedOperation>> {
    service
        .operations
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| napi::Error::from_reason("account operation not found"))
}

pub(super) fn resume<'env>(
    env: &'env napi::Env,
    service: Arc<Service>,
    id: String,
    now_ms: i64,
) -> napi::Result<PromiseRaw<'env, AccountOperationResult>> {
    let pending = pending(&service, &id)?;
    env.spawn_future(async move {
        let work = pending.core.resume(&id, now_ms, pending.cancel.clone());
        tokio::pin!(work);
        let outcome = tokio::select! {
            biased;
            _ = service.closed.cancelled() => {
                pending.cancel.cancel();
                work.await
            }
            outcome = &mut work => outcome,
        };
        Ok(outcome.into())
    })
}

pub(super) fn read<'env>(
    env: &'env napi::Env,
    service: Arc<Service>,
    id: String,
    now_ms: i64,
) -> napi::Result<PromiseRaw<'env, AccountOperationResult>> {
    let pending = pending(&service, &id)?;
    env.spawn_future(async move { Ok(pending.core.settled_outcome(now_ms).await.into()) })
}

pub(super) fn cancel(service: &Service, id: &str) {
    if let Some(pending) = service.operations.lock().unwrap().get(id) {
        pending.cancel.cancel();
        pending.core.cancel(id);
    }
}
