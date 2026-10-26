//! Mobile application capabilities shared by Swift and Kotlin, without platform bindings.
mod account;
mod api;
mod connection;
mod error;
mod runtime;

pub use account::{AccountOperation, AccountOutcome};
pub use api::ApiCall;
pub use connection::{Authentication, ConnectionSnapshot, ConnectionSubscription, Status};
pub use error::{LocalErrorKind, MobileError, Result};
pub use xw_api::{RequestOptions, Transport};

use prost::Message;
use proto_server_rs::xiaowei::server::auth::{Authenticated, LoginRequest};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
use xw_api::account::{Operation, SessionCore};

#[derive(Clone, Default)]
pub struct SessionContext {
    pub server: String,
    pub authenticated: Option<Vec<u8>>,
    pub connect: bool,
}

impl SessionContext {
    fn decode(&self) -> Result<(String, Option<xw_api::account::Session>)> {
        let server = xw_api::normalize_server(&self.server)?;
        let authenticated = self
            .authenticated
            .as_deref()
            .map(Authenticated::decode)
            .transpose()
            .map_err(|_| xw_api::Error::invalid("无效的宿主认证数据"))?;
        let session = authenticated.map(|authenticated| xw_api::account::Session {
            server: server.clone(),
            authenticated,
        });
        Ok((server, session))
    }

    fn target(&self) -> Result<xw_api::Target> {
        let (server, session) = self.decode()?;
        Ok(xw_api::Target {
            server: server.clone(),
            session: session.and_then(|session| {
                session.authenticated.tokens.map(|tokens| xw_api::Session {
                    server,
                    session_id: tokens.session_id,
                    access_token: tokens.access_token,
                    access_expires_at_ms: tokens.access_expires_at_ms,
                })
            }),
        })
    }

    fn identity(&self) -> Result<(String, String, String)> {
        let (server, session) = self.decode()?;
        let authenticated = session
            .map(|session| session.authenticated)
            .unwrap_or_default();
        Ok((
            server,
            authenticated
                .user
                .map_or_else(String::new, |user| user.user_id),
            authenticated
                .tokens
                .map_or_else(String::new, |tokens| tokens.session_id),
        ))
    }
}

struct State {
    context: Option<SessionContext>,
    suspended: bool,
    transitioning: bool,
    closed: bool,
    account: Option<Arc<account::AccountWork>>,
    calls: Vec<Arc<api::ApiWork>>,
    closing: Option<runtime::Task<()>>,
}

pub struct MobileClient {
    api: Arc<xw_api::Client>,
    current: Arc<SessionCore>,
    stop: CancellationToken,
    state: Mutex<State>,
    lifecycle: Arc<tokio::sync::Mutex<()>>,
}

impl MobileClient {
    pub fn new() -> Result<Arc<Self>> {
        let _runtime = runtime::get()?.enter();
        let api = xw_api::Client::new()?;
        log::debug!("Mobile client initialized");
        Ok(Arc::new(Self {
            current: SessionCore::new(api.clone()),
            api,
            stop: CancellationToken::new(),
            state: Mutex::new(State {
                context: None,
                suspended: false,
                transitioning: false,
                closed: false,
                account: None,
                calls: vec![],
                closing: None,
            }),
            lifecycle: Arc::new(tokio::sync::Mutex::new(())),
        }))
    }

    pub async fn set_session(self: &Arc<Self>, context: SessionContext) -> Result<i64> {
        context.decode()?;
        let gate = self.lifecycle.clone().lock_owned().await;
        let client = self.clone();
        runtime::spawn(async move {
            let _gate = gate;
            client.apply_session(context).await
        })?
        .await
    }

    async fn apply_session(&self, context: SessionContext) -> Result<i64> {
        let (server, session) = context.decode()?;
        let identity = context.identity()?;
        let (account, calls) = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(MobileError::closed());
            }
            let previous = state
                .context
                .as_ref()
                .map(SessionContext::identity)
                .transpose()?;
            let changed = match previous {
                Some(previous) => previous != identity,
                // A first commit may acknowledge this operation's rotated credentials.
                None => !state
                    .account
                    .as_ref()
                    .is_some_and(|work| work.identity() == &identity),
            };
            state.transitioning = true;
            if changed {
                Self::cancel_work(&state);
                (state.account.clone(), std::mem::take(&mut state.calls))
            } else {
                (None, vec![])
            }
        };
        let settled = Self::settle_work(account, calls).await;
        let mut state = self.state.lock().unwrap();
        state.transitioning = false;
        settled?;
        if state.closed {
            return Err(MobileError::closed());
        }
        // Old connection owners have settled before the new target becomes visible.
        self.current
            .activate(server, session, context.connect, xw_api::now_ms());
        // activate(connect = false) does not clear an older active connection itself.
        if !context.connect {
            self.api
                .connection
                .set_target(xw_api::Target::default(), xw_api::now_ms());
        }
        state.context = Some(context);
        state.suspended = false;
        Ok(self
            .current
            .outcome(xw_api::now_ms())
            .next_maintenance_at_ms)
    }

    fn available(state: &State) -> Result<()> {
        if state.closed {
            return Err(MobileError::closed());
        }
        if state.suspended {
            return Err(MobileError::local(
                LocalErrorKind::InvalidState,
                "移动客户端已暂停",
            ));
        }
        if state.transitioning {
            return Err(MobileError::local(
                LocalErrorKind::Busy,
                "移动客户端正在切换上下文",
            ));
        }
        Ok(())
    }

    fn operation(
        &self,
        mut context: SessionContext,
        command: Operation,
    ) -> Result<Arc<AccountOperation>> {
        let mut state = self.state.lock().unwrap();
        Self::available(&state)?;
        if state.account.as_ref().is_some_and(|work| !work.released()) {
            return Err(MobileError::local(
                LocalErrorKind::Busy,
                "请先处理并关闭当前账号操作",
            ));
        }
        if matches!(command, Operation::Login(_) | Operation::Revoke) {
            context.connect = false;
        }
        if context.connect
            && state
                .context
                .as_ref()
                .map(SessionContext::identity)
                .transpose()?
                != Some(context.identity()?)
        {
            return Err(MobileError::local(
                LocalErrorKind::InvalidState,
                "账号操作不是当前连接目标",
            ));
        }
        let operation =
            AccountOperation::new(self.api.clone(), &context, command, self.stop.child_token())?;
        state.account = Some(operation.work.clone());
        Ok(operation)
    }

    pub fn login(
        &self,
        context: SessionContext,
        request: Vec<u8>,
    ) -> Result<Arc<AccountOperation>> {
        let request = LoginRequest::decode(request.as_slice())
            .map_err(|_| xw_api::Error::invalid("无效的登录请求"))?;
        self.operation(context, Operation::Login(request))
    }

    pub fn restore(&self, context: SessionContext, force: bool) -> Result<Arc<AccountOperation>> {
        self.operation(context, Operation::Restore { force })
    }

    pub fn maintain(&self, context: SessionContext, force: bool) -> Result<Arc<AccountOperation>> {
        self.operation(context, Operation::Maintain { force })
    }

    pub fn logout(&self, context: SessionContext) -> Result<Arc<AccountOperation>> {
        self.operation(context, Operation::Logout)
    }

    pub fn revoke(&self, context: SessionContext) -> Result<Arc<AccountOperation>> {
        self.operation(context, Operation::Revoke)
    }

    pub fn invoke(
        &self,
        context: SessionContext,
        method: String,
        payload: Vec<u8>,
        options: RequestOptions,
    ) -> Result<Arc<ApiCall>> {
        let mut state = self.state.lock().unwrap();
        Self::available(&state)?;
        let mut request = xw_api::RequestContext::new(context.target()?);
        request.options = options;
        request.cancellation = self.stop.child_token();
        let call = ApiCall::new(self.api.clone(), method, payload, request);
        state.calls.retain(|call| !call.finished());
        state.calls.push(call.work.clone());
        Ok(call)
    }

    pub fn subscribe_connection(&self) -> Result<Arc<ConnectionSubscription>> {
        let state = self.state.lock().unwrap();
        if state.closed {
            return Err(MobileError::closed());
        }
        Ok(ConnectionSubscription::new(
            self.api.connection.subscribe(),
            self.stop.child_token(),
        ))
    }

    fn cancel_work(state: &State) {
        if let Some(work) = &state.account {
            work.cancel();
        }
        for work in &state.calls {
            work.cancel();
        }
    }

    async fn settle_work(
        account: Option<Arc<account::AccountWork>>,
        calls: Vec<Arc<api::ApiWork>>,
    ) -> Result<()> {
        let result = if let Some(account) = account {
            account.close().await
        } else {
            Ok(())
        };
        for call in calls {
            call.close().await;
        }
        result
    }

    pub async fn suspend(self: &Arc<Self>) -> Result<()> {
        let gate = self.lifecycle.clone().lock_owned().await;
        let client = self.clone();
        runtime::spawn(async move {
            let _gate = gate;
            client.pause().await
        })?
        .await
    }

    async fn pause(&self) -> Result<()> {
        let (account, calls) = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(MobileError::closed());
            }
            state.suspended = true;
            state.transitioning = true;
            Self::cancel_work(&state);
            self.current.suspend();
            self.api
                .connection
                .set_target(xw_api::Target::default(), xw_api::now_ms());
            (state.account.clone(), std::mem::take(&mut state.calls))
        };
        let result = Self::settle_work(account, calls).await;
        self.api
            .connection
            .set_target(xw_api::Target::default(), xw_api::now_ms());
        self.state.lock().unwrap().transitioning = false;
        log::debug!("Mobile client suspended");
        result
    }

    pub async fn close(self: &Arc<Self>) -> Result<()> {
        let task = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            self.stop.cancel();
            Self::cancel_work(&state);
            if state.closing.is_none() {
                let client = self.clone();
                state.closing = Some(runtime::spawn(async move {
                    let _gate = client.lifecycle.lock().await;
                    let (account, calls) = {
                        let mut state = client.state.lock().unwrap();
                        (state.account.take(), std::mem::take(&mut state.calls))
                    };
                    let result = Self::settle_work(account, calls).await;
                    client.current.close().await;
                    client.api.close().await;
                    log::debug!("Mobile client closed");
                    result
                })?);
            }
            state.closing.clone().unwrap()
        };
        task.await
    }
}

impl Drop for MobileClient {
    fn drop(&mut self) {
        self.stop.cancel();
        let state = self.state.get_mut().unwrap();
        Self::cancel_work(state);
        if state.closed {
            return;
        }
        if let Ok(runtime) = runtime::get() {
            let _runtime = runtime.enter();
            self.current.suspend();
            self.api
                .connection
                .set_target(xw_api::Target::default(), xw_api::now_ms());
            let account = state.account.take();
            let calls = std::mem::take(&mut state.calls);
            let current = self.current.clone();
            let api = self.api.clone();
            runtime.spawn(async move {
                let _ = Self::settle_work(account, calls).await;
                current.close().await;
                api.close().await;
            });
        }
    }
}
