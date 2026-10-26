mod operation;

use napi::bindgen_prelude::{Buffer, PromiseRaw};
use napi_derive::napi;
use operation::{AccountOperationAccess, AccountOperationContext, AccountOperationResult};
use prost::Message;
use proto_server_rs::xiaowei::server::auth::LoginRequest;
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;
use xw_api::account::SessionCore;

use crate::gateway::GatewayEndpoint;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostSession {
    #[serde(default)]
    pub operation_id: String,
    pub server: String,
    pub session_server: Option<String>,
    pub authenticated: Option<Vec<u8>>,
    #[serde(default)]
    pub connect: bool,
    pub now_ms: i64,
}

impl HostSession {
    fn session(&self) -> Result<Option<xw_api::account::Session>, xw_gateway::GatewayError> {
        self.authenticated
            .as_ref()
            .map(|bytes| {
                let authenticated =
                    proto_server_rs::xiaowei::server::auth::Authenticated::decode(bytes.as_slice())
                        .map_err(|_| {
                            xw_gateway::GatewayError::new(
                                xw_gateway::ErrorCode::InvalidArgument,
                                "invalid host credentials",
                            )
                        })?;
                Ok(xw_api::account::Session {
                    server: self
                        .session_server
                        .clone()
                        .unwrap_or_else(|| self.server.clone()),
                    authenticated,
                })
            })
            .transpose()
    }
}

pub(crate) struct HostedOperation {
    core: Arc<SessionCore>,
    cancel: CancellationToken,
}

pub(crate) struct Service {
    pub api: Arc<xw_api::Client>,
    pub current: Arc<SessionCore>,
    current_context: Mutex<Option<HostSession>>,
    requests: Mutex<HashMap<String, HostSession>>,
    operations: Mutex<HashMap<String, Arc<HostedOperation>>>,
    pub closed: CancellationToken,
}

impl Service {
    pub fn api_context(
        &self,
        token: &str,
    ) -> Result<xw_api::RequestContext, xw_gateway::GatewayError> {
        let scoped = self.requests.lock().unwrap().get(token).cloned();
        let host = scoped
            .clone()
            .or_else(|| self.current_context.lock().unwrap().clone());
        let Some(host) = host else {
            return Ok(xw_api::RequestContext::new(xw_api::Target::default()));
        };
        let session = host.session()?.and_then(|session| {
            session.authenticated.tokens.map(|tokens| xw_api::Session {
                server: session.server,
                session_id: tokens.session_id,
                access_token: tokens.access_token,
                access_expires_at_ms: tokens.access_expires_at_ms,
            })
        });
        let mut context = xw_api::RequestContext::new(xw_api::Target {
            server: host.server,
            session,
        });
        if scoped.is_some() {
            context.now_ms = host.now_ms;
        }
        Ok(context)
    }

    pub fn prepare(self: &Arc<Self>, control: &str, metadata: &str) -> Option<ContextLease> {
        let control: serde_json::Value = serde_json::from_str(control).ok()?;
        if control.get("operation")?.as_str()? != "invoke" {
            return None;
        }
        let metadata: serde_json::Value = serde_json::from_str(metadata).ok()?;
        let token = metadata.get("token")?.as_str()?.to_string();
        let context: HostSession =
            serde_json::from_value(metadata.get("accountSession")?.clone()).ok()?;
        self.requests.lock().unwrap().insert(token.clone(), context);
        Some(ContextLease {
            service: self.clone(),
            token,
        })
    }

    pub(crate) fn operation(
        &self,
        context: &HostSession,
    ) -> Result<Arc<HostedOperation>, xw_gateway::GatewayError> {
        let mut operations = self.operations.lock().unwrap();
        if context.operation_id.is_empty() || context.operation_id.len() > 100 {
            return Err(xw_gateway::GatewayError::new(
                xw_gateway::ErrorCode::InvalidArgument,
                "invalid account operation",
            ));
        }
        if let Some(core) = operations.get(&context.operation_id) {
            return Ok(core.clone());
        }
        if self.closed.is_cancelled() || operations.len() >= 128 {
            return Err(xw_gateway::GatewayError::new(
                xw_gateway::ErrorCode::ResourceExhausted,
                "account operations unavailable",
            ));
        }
        let core = SessionCore::new(self.api.clone());
        core.activate(
            context.server.clone(),
            context.session()?,
            context.connect,
            context.now_ms,
        );
        let pending = Arc::new(HostedOperation {
            core,
            cancel: CancellationToken::new(),
        });
        operations.insert(context.operation_id.clone(), pending.clone());
        Ok(pending)
    }

    pub(crate) fn release(&self, id: &str) {
        if let Some(pending) = self.operations.lock().unwrap().remove(id) {
            pending.cancel.cancel();
            pending.core.cancel(id);
        }
    }

    pub async fn close(&self) {
        self.closed.cancel();
        let operations = std::mem::take(&mut *self.operations.lock().unwrap());
        for (id, pending) in operations {
            pending.cancel.cancel();
            pending.core.cancel(&id);
            pending.core.close().await;
        }
        self.current.close().await;
        self.api.close().await;
        self.requests.lock().unwrap().clear();
        self.current_context.lock().unwrap().take();
    }
}

pub(crate) struct ContextLease {
    service: Arc<Service>,
    token: String,
}

impl Drop for ContextLease {
    fn drop(&mut self) {
        self.service.requests.lock().unwrap().remove(&self.token);
    }
}

#[napi]
pub struct XwAccount {
    service: Arc<Service>,
}

#[napi]
impl XwAccount {
    #[napi(constructor)]
    pub fn new() -> napi::Result<Self> {
        let api =
            xw_api::Client::new().map_err(|error| napi::Error::from_reason(error.to_string()))?;
        Ok(Self {
            service: Arc::new(Service {
                current: SessionCore::new(api.clone()),
                api,
                current_context: Mutex::new(None),
                requests: Mutex::new(HashMap::new()),
                operations: Mutex::new(HashMap::new()),
                closed: CancellationToken::new(),
            }),
        })
    }

    #[napi]
    pub fn create_gateway_endpoint(&self, env: napi::Env) -> napi::Result<GatewayEndpoint> {
        crate::xwapi::gateway::create(&self.service, &env)
    }

    /// Host lifecycle/configuration; session operations use the fixed methods below.
    #[napi]
    pub fn set_session(&self, input: String) -> napi::Result<i64> {
        let context: HostSession = serde_json::from_str(&input)
            .map_err(|_| napi::Error::from_reason("invalid host session"))?;
        let session = context
            .session()
            .map_err(|_| napi::Error::from_reason("invalid host credentials"))?;
        *self.service.current_context.lock().unwrap() = Some(context.clone());
        napi::bindgen_prelude::within_runtime_if_available(|| {
            self.service
                .current
                .activate(context.server, session, true, context.now_ms);
        });
        Ok(self
            .service
            .current
            .outcome(context.now_ms)
            .next_maintenance_at_ms)
    }

    #[napi]
    pub fn login<'env>(
        &self,
        env: &'env napi::Env,
        context: AccountOperationContext,
        request: Buffer,
        access: AccountOperationAccess,
    ) -> napi::Result<PromiseRaw<'env, AccountOperationResult>> {
        let request = LoginRequest::decode(request.as_ref())
            .map_err(|_| napi::Error::from_reason("invalid login request"))?;
        operation::start(
            env,
            self.service.clone(),
            context,
            xw_api::account::Operation::Login(request),
            access,
        )
    }

    #[napi]
    pub fn restore<'env>(
        &self,
        env: &'env napi::Env,
        context: AccountOperationContext,
        force: bool,
        access: AccountOperationAccess,
    ) -> napi::Result<PromiseRaw<'env, AccountOperationResult>> {
        operation::start(
            env,
            self.service.clone(),
            context,
            xw_api::account::Operation::Restore { force },
            access,
        )
    }

    #[napi]
    pub fn logout<'env>(
        &self,
        env: &'env napi::Env,
        context: AccountOperationContext,
        access: AccountOperationAccess,
    ) -> napi::Result<PromiseRaw<'env, AccountOperationResult>> {
        operation::start(
            env,
            self.service.clone(),
            context,
            xw_api::account::Operation::Logout,
            access,
        )
    }

    #[napi]
    pub fn revoke<'env>(
        &self,
        env: &'env napi::Env,
        context: AccountOperationContext,
        access: AccountOperationAccess,
    ) -> napi::Result<PromiseRaw<'env, AccountOperationResult>> {
        operation::start(
            env,
            self.service.clone(),
            context,
            xw_api::account::Operation::Revoke,
            access,
        )
    }

    #[napi]
    pub fn continue_operation<'env>(
        &self,
        env: &'env napi::Env,
        id: String,
        now_ms: i64,
    ) -> napi::Result<PromiseRaw<'env, AccountOperationResult>> {
        operation::resume(env, self.service.clone(), id, now_ms)
    }

    #[napi]
    pub fn read_result<'env>(
        &self,
        env: &'env napi::Env,
        id: String,
        now_ms: i64,
    ) -> napi::Result<PromiseRaw<'env, AccountOperationResult>> {
        operation::read(env, self.service.clone(), id, now_ms)
    }

    #[napi]
    pub fn cancel_operation(&self, id: String) {
        operation::cancel(&self.service, &id);
    }

    #[napi]
    pub fn release_operation(&self, id: String) {
        self.service.release(&id);
    }

    #[napi]
    pub fn connection_generation(&self) -> i64 {
        self.service.api.connection.subscribe().borrow().generation as i64
    }
}
