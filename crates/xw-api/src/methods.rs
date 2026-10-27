use crate::Transport;
use prost::Message;
use proto_server_rs::xiaowei::server as pb;

use crate::{Client, Error, RequestContext, Result, contract::Method, normalize_server};

// Log completion even when the caller drops an in-flight request future.
struct WebsocketRequestLog {
    method: String,
    origin: String,
    started: std::time::Instant,
    code: Option<String>,
    message: Option<String>,
    failure: Option<Error>,
    level: log::Level,
}

impl Drop for WebsocketRequestLog {
    fn drop(&mut self) {
        let mut metadata = format!(
            "WebSocket request completed method={} server={} duration_ms={}",
            self.method,
            self.origin,
            self.started.elapsed().as_millis()
        );
        if let Some(code) = &self.code {
            metadata.push_str(&format!(" code={code}"));
        }
        if let Some(message) = &self.message {
            metadata.push_str(&format!(" msg={message:?}"));
        }
        if let Some(error) = &self.failure {
            metadata.push_str(&format!(
                " error_code={} error_msg={:?}",
                error.code, error.message
            ));
        }
        log::log!(self.level, "{metadata}");
    }
}

impl Client {
    pub async fn invoke(
        &self,
        name: &str,
        payload: &[u8],
        context: &RequestContext,
    ) -> Result<Vec<u8>> {
        if self.closed.is_cancelled() {
            return Err(Error::unavailable("服务器接口服务已关闭"));
        }
        if context.cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        let method = Method::resolve(name)?;
        let timeout = context.options.timeout_ms.unwrap_or(15_000);
        if timeout > i32::MAX as u32 {
            return Err(Error::invalid("请求超时时间无效"));
        }
        let transport = context.options.transport;
        if transport == Transport::Websocket && !method.requires_login {
            return Err(Error::invalid("此接口不支持 WebSocket"));
        }
        let token = if method.requires_login {
            let session = context
                .target
                .session
                .as_ref()
                .ok_or_else(Error::unauthenticated)?;
            if session.session_id.is_empty()
                || session.access_token.is_empty()
                || session.server != context.target.server
                || session.access_expires_at_ms <= context.now_ms
            {
                log::warn!(
                    "Xwapi request rejected method={} reason=unusable_session",
                    method.id
                );
                return Err(Error::unauthenticated());
            }
            Some(session.access_token.as_str())
        } else {
            None
        };
        let server = normalize_server(&context.target.server)?;
        self.validate_request(name, payload)?;
        let route = crate::wire::Route::unary(&method);
        let use_ws = transport == Transport::Websocket
            || (transport == Transport::Auto
                && method.requires_login
                && self.connection.can_invoke(&route, &context.target));
        let mut request_log = use_ws.then(|| {
            let origin = url::Url::parse(&server)
                .map(|url| url.origin().ascii_serialization())
                .unwrap_or_default();
            log::debug!(
                "WebSocket request started method={} timeout_ms={} server={}",
                method.id,
                timeout,
                origin
            );
            WebsocketRequestLog {
                method: method.id.clone(),
                origin,
                started: std::time::Instant::now(),
                code: Some("CANCELLED".into()),
                message: Some("request cancelled".into()),
                failure: None,
                level: log::Level::Debug,
            }
        });
        let bytes = if use_ws {
            // Once dispatched, an error is terminal. Never replay it over HTTP.
            let pending = async {
                let peer = self
                    .connection
                    .peer(&route, &context.target)
                    .ok_or_else(|| {
                        crate::wire::WireError::new(
                            "OWNER_UNAVAILABLE",
                            "WebSocket connection not ready",
                        )
                    })?;
                peer.invoke(
                    route,
                    payload.to_vec(),
                    timeout,
                    context.cancellation.clone(),
                )
                .await
            };
            let result = tokio::select! {
                _ = self.closed.cancelled() => {
                    Err(crate::wire::WireError::new("CANCELLED", "client closed"))
                },
                result = pending => result,
            };
            result.map_err(|error| {
                let log = request_log.as_mut().unwrap();
                log.code = Some(error.code.clone());
                log.message = Some(error.message.clone());
                log.level = match error.code.as_str() {
                    "CANCELLED" => log::Level::Debug,
                    "HANDLER_ERROR" | "OWNER_UNAVAILABLE" => log::Level::Error,
                    _ => log::Level::Warn,
                };
                websocket_error(error)
            })?
        } else {
            self.http_request(&method, payload, context, &server, token)
                .await?
        };
        let validation = self.validate_response(name, payload, &bytes);
        if let Some(log) = &mut request_log {
            log.code = None;
            log.message = None;
            if let Ok(response) = pb::BaseResponse::decode(bytes.as_slice()) {
                log.code = Some(response.code.to_string());
                log.message = Some(response.msg);
                log.level = match response.code {
                    0 => log::Level::Debug,
                    10008 | 10009 => log::Level::Error,
                    _ => log::Level::Warn,
                };
            }
            if let Err(error) = &validation {
                log.failure = Some(error.clone());
                log.level = log::Level::Error;
            }
        }
        validation?;
        Ok(bytes)
    }

    fn validate_request(&self, name: &str, bytes: &[u8]) -> Result<()> {
        if name == "xiaowei.server.Auth.Refresh" {
            let request =
                pb::RefreshRequest::decode(bytes).map_err(|_| Error::invalid("无效的刷新请求"))?;
            if request.refresh_token.is_empty() {
                return Err(Error::invalid("刷新凭据不能为空"));
            }
        }
        Ok(())
    }

    fn validate_response(&self, name: &str, request: &[u8], bytes: &[u8]) -> Result<()> {
        let base = pb::BaseResponse::decode(bytes)
            .map_err(|_| Error::unavailable("服务器返回了无效的响应"))?;
        if base.code != 0 {
            return Ok(());
        }
        if base.data.is_none() {
            return Err(Error::unavailable("服务器返回了无效的响应"));
        }
        let invalid = || Error::unavailable("服务器返回了无效的响应");
        match name {
            "xiaowei.server.Auth.Login" => {
                let request = pb::LoginRequest::decode(request).map_err(|_| invalid())?;
                let result = pb::LoginResponse::decode(bytes)
                    .map_err(|_| invalid())?
                    .data
                    .and_then(|data| data.result);
                match result {
                    Some(pb::login_result::Result::Authenticated(auth)) => {
                        if auth
                            .user
                            .as_ref()
                            .is_none_or(|user| user.user_id.is_empty())
                            || auth
                                .device
                                .as_ref()
                                .is_none_or(|device| device.device_id != request.device_id)
                            || !auth.tokens.as_ref().is_some_and(valid_tokens)
                        {
                            return Err(invalid());
                        }
                    }
                    Some(pb::login_result::Result::BindingRequired(binding)) => {
                        if binding.thirdparty_bind_token.is_empty() || binding.expires_at_ms <= 0 {
                            return Err(invalid());
                        }
                    }
                    None => return Err(invalid()),
                }
            }
            "xiaowei.server.Auth.Refresh" => {
                if !pb::RefreshResponse::decode(bytes)
                    .map_err(|_| invalid())?
                    .data
                    .as_ref()
                    .is_some_and(valid_tokens)
                {
                    return Err(invalid());
                }
            }
            "xiaowei.server.Auth.GetCurrentUser" => {
                let data = pb::GetCurrentUserResponse::decode(bytes)
                    .map_err(|_| invalid())?
                    .data
                    .ok_or_else(invalid)?;
                if data
                    .user
                    .as_ref()
                    .is_none_or(|user| user.user_id.is_empty())
                    || data
                        .device
                        .as_ref()
                        .is_none_or(|device| device.device_id.is_empty())
                    || data.session_id.is_empty()
                {
                    return Err(invalid());
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub async fn login(
        &self,
        request: pb::LoginRequest,
        context: &RequestContext,
    ) -> Result<pb::LoginResponse> {
        self.typed("xiaowei.server.Auth.Login", request, context)
            .await
    }

    pub async fn refresh(
        &self,
        request: pb::RefreshRequest,
        context: &RequestContext,
    ) -> Result<pb::RefreshResponse> {
        self.typed("xiaowei.server.Auth.Refresh", request, context)
            .await
    }

    pub async fn current_user(
        &self,
        context: &RequestContext,
    ) -> Result<pb::GetCurrentUserResponse> {
        self.typed("xiaowei.server.Auth.GetCurrentUser", (), context)
            .await
    }

    pub async fn logout(&self, context: &RequestContext) -> Result<pb::LogoutResponse> {
        self.typed("xiaowei.server.Auth.Logout", (), context).await
    }

    async fn typed<Req: Message, Res: Message + Default>(
        &self,
        name: &str,
        request: Req,
        context: &RequestContext,
    ) -> Result<Res> {
        let bytes = self.invoke(name, &request.encode_to_vec(), context).await?;
        Res::decode(bytes.as_slice()).map_err(|_| Error::unavailable("服务器返回了无效的响应"))
    }
}

fn websocket_error(error: crate::wire::WireError) -> Error {
    use pb::ErrorCode;

    if error.code == "CANCELLED" {
        return Error::cancelled();
    }
    let (code, category, summary) = match error.code.as_str() {
        "UNAUTHORIZED" => (
            ErrorCode::Unauthenticated,
            "credentials",
            "服务器拒绝了此操作",
        ),
        "INVALID_ARGUMENT" | "WRONG_METHOD_KIND" => {
            (ErrorCode::InvalidArgument, "argument", "服务器请求无效")
        }
        "UNKNOWN_ROUTE" => (ErrorCode::NotFound, "protocol", "服务器未提供此接口"),
        "RESOURCE_EXHAUSTED" | "CONCURRENCY_FULL" => (
            ErrorCode::RateLimited,
            "network",
            "服务器请求过于频繁，请稍后重试",
        ),
        "INCOMPATIBLE" => (
            ErrorCode::Unavailable,
            "protocol",
            "客户端与服务器接口不兼容",
        ),
        "TIMEOUT" => (
            ErrorCode::Unavailable,
            "timeout",
            "服务器请求超时，请稍后重试",
        ),
        "OWNER_UNAVAILABLE" => (ErrorCode::Unavailable, "network", "服务器接口暂不可用"),
        "HANDLER_ERROR" => (ErrorCode::InternalError, "protocol", "服务器处理请求失败"),
        _ => (
            ErrorCode::Unavailable,
            "protocol",
            if error.message.is_empty() {
                "服务器请求失败"
            } else {
                &error.message
            },
        ),
    };
    Error {
        code: code as i32,
        message: summary.into(),
        category,
    }
}

pub fn valid_tokens(tokens: &pb::TokenPair) -> bool {
    !tokens.access_token.is_empty()
        && !tokens.refresh_token.is_empty()
        && !tokens.session_id.is_empty()
        && tokens.access_expires_at_ms > 0
        && tokens.refresh_expires_at_ms > 0
}
