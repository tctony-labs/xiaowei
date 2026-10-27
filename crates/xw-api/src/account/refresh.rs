use super::{Session, SessionCore};
use proto_server_rs::xiaowei::server as pb;

pub(super) const LEAD_MS: i64 = 5 * 60_000;

impl SessionCore {
    pub(super) async fn fresh(
        &self,
        session: &mut Session,
        force: bool,
        context: &crate::RequestContext,
        access: super::Access,
    ) -> crate::Result<bool> {
        let tokens = session
            .authenticated
            .tokens
            .as_ref()
            .ok_or_else(crate::Error::unauthenticated)?;
        if tokens.refresh_expires_at_ms <= context.now_ms {
            return Err(crate::Error {
                message: "登录已失效，请重新登录".into(),
                ..crate::Error::unauthenticated()
            });
        }
        if !force && tokens.access_expires_at_ms > context.now_ms + LEAD_MS {
            return Ok(false);
        }
        super::Access::check(access.refresh)?;
        let response = self
            .api
            .refresh(
                pb::RefreshRequest {
                    refresh_token: tokens.refresh_token.clone(),
                },
                context,
            )
            .await?;
        super::session::business(response.code, &response.msg)?;
        let next = response
            .data
            .ok_or_else(|| crate::Error::unavailable("服务器返回了无效的刷新结果"))?;
        if next.session_id != tokens.session_id {
            return Err(crate::Error::unavailable("服务器返回了不匹配的会话"));
        }
        // No await between accepting a rotation and retaining its complete pair.
        session.authenticated.tokens = Some(next);
        log::info!("Account session credentials rotated");
        Ok(true)
    }
}
