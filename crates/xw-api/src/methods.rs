use crate::Transport;
use prost::Message;
use proto_server_rs::xiaowei::server::{auth as pb, common};

use crate::{Client, Error, RequestContext, Result, contract::Method, normalize_server};

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
        let bytes = if use_ws {
            let peer = self
                .connection
                .peer(&route, &context.target)
                .ok_or_else(|| Error::unavailable("云连接尚未就绪"))?;
            // Once dispatched, an error is terminal. Never replay it over HTTP.
            let started = std::time::Instant::now();
            let pending = peer.invoke(
                route,
                payload.to_vec(),
                timeout,
                context.cancellation.clone(),
            );
            let result = tokio::select! {
                _ = self.closed.cancelled() => Err(crate::wire::WireError::unavailable()),
                result = pending => result,
            };
            log::debug!(
                "WebSocket request completed method={} outcome={} duration_ms={}",
                method.id,
                if result.is_ok() {
                    "response"
                } else {
                    "unavailable"
                },
                started.elapsed().as_millis()
            );
            result.map_err(|_| Error::unavailable("云连接不可用，请稍后重试"))?
        } else {
            self.http_request(&method, payload, context, &server, token)
                .await?
        };
        if let Err(error) = self.validate_response(name, payload, &bytes) {
            return Err(if use_ws {
                Error::unavailable("云连接不可用，请稍后重试")
            } else {
                error
            });
        }
        Ok(bytes)
    }

    fn validate_request(&self, name: &str, bytes: &[u8]) -> Result<()> {
        if name == "xiaowei.server.auth.Auth.Refresh" {
            let request =
                pb::RefreshRequest::decode(bytes).map_err(|_| Error::invalid("无效的刷新请求"))?;
            if request.refresh_token.is_empty() {
                return Err(Error::invalid("刷新凭据不能为空"));
            }
        }
        Ok(())
    }

    fn validate_response(&self, name: &str, request: &[u8], bytes: &[u8]) -> Result<()> {
        let base = common::BaseResponse::decode(bytes)
            .map_err(|_| Error::unavailable("服务器返回了无效的响应"))?;
        if base.code != 0 {
            return Ok(());
        }
        if base.data.is_none() {
            return Err(Error::unavailable("服务器返回了无效的响应"));
        }
        let invalid = || Error::unavailable("服务器返回了无效的响应");
        match name {
            "xiaowei.server.auth.Auth.Login" => {
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
            "xiaowei.server.auth.Auth.Refresh" => {
                if !pb::RefreshResponse::decode(bytes)
                    .map_err(|_| invalid())?
                    .data
                    .as_ref()
                    .is_some_and(valid_tokens)
                {
                    return Err(invalid());
                }
            }
            "xiaowei.server.auth.Auth.GetCurrentUser" => {
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
        self.typed("xiaowei.server.auth.Auth.Login", request, context)
            .await
    }

    pub async fn refresh(
        &self,
        request: pb::RefreshRequest,
        context: &RequestContext,
    ) -> Result<pb::RefreshResponse> {
        self.typed("xiaowei.server.auth.Auth.Refresh", request, context)
            .await
    }

    pub async fn current_user(
        &self,
        context: &RequestContext,
    ) -> Result<pb::GetCurrentUserResponse> {
        self.typed("xiaowei.server.auth.Auth.GetCurrentUser", (), context)
            .await
    }

    pub async fn logout(&self, context: &RequestContext) -> Result<pb::LogoutResponse> {
        self.typed("xiaowei.server.auth.Auth.Logout", (), context)
            .await
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

pub fn valid_tokens(tokens: &pb::TokenPair) -> bool {
    !tokens.access_token.is_empty()
        && !tokens.refresh_token.is_empty()
        && !tokens.session_id.is_empty()
        && tokens.access_expires_at_ms > 0
        && tokens.refresh_expires_at_ms > 0
}
