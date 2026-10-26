use super::{
    Access, Outcome, Session, SessionCore, State,
    types::{Next, Phase},
};
use crate::Transport;
use crate::{RequestContext, Target, connection::Authentication};
use proto_server_rs::xiaowei::server::auth as pb;
use tokio_util::sync::CancellationToken;

pub(super) fn business(code: i32, message: &str) -> crate::Result<()> {
    if code == 0 {
        return Ok(());
    }
    Err(crate::Error {
        code,
        message: message.into(),
        category: "business",
    })
}

impl SessionCore {
    pub(super) fn target(state: &State) -> Target {
        let session = state.session.as_ref().and_then(|session| {
            let tokens = session.authenticated.tokens.as_ref()?;
            Some(crate::Session {
                server: session.server.clone(),
                session_id: tokens.session_id.clone(),
                access_token: tokens.access_token.clone(),
                access_expires_at_ms: tokens.access_expires_at_ms,
            })
        });
        Target {
            server: state.server.clone(),
            session,
        }
    }

    pub(super) async fn drive(&self, now_ms: i64) -> Outcome {
        let (generation, cancel) = {
            let state = self.state.lock().unwrap();
            let pending = state.pending.as_ref().unwrap();
            (pending.generation, pending.cancel.clone())
        };
        let guard = cancel.clone().drop_guard();
        let result = self.drive_inner(now_ms, generation, cancel).await;
        guard.disarm();
        result
    }

    async fn drive_inner(
        &self,
        now_ms: i64,
        generation: u64,
        cancel: CancellationToken,
    ) -> Outcome {
        loop {
            let (phase, access, mut session, mut context, connect) = {
                let mut state = self.state.lock().unwrap();
                if state.generation != generation {
                    return Self::cancelled_outcome(None, now_ms);
                }
                if cancel.is_cancelled() {
                    return Self::failure(&mut state, crate::Error::cancelled(), now_ms);
                }
                let pending = state.pending.as_ref().unwrap();
                let mut context = RequestContext::new(Self::target(&state));
                context.now_ms = now_ms;
                context.cancellation = cancel.clone();
                (
                    pending.phase.clone(),
                    pending.access,
                    state.session.clone(),
                    context,
                    state.connect && !state.suspended,
                )
            };
            let mut checkpoint = false;
            let mut rotated = false;
            let action: crate::Result<Phase> = async {
                match phase.clone() {
                    Phase::Complete => Ok(Phase::Complete),
                    Phase::Login(request) => {
                        Access::check(access.login)?;
                        let response = self.api.login(request, &context).await?;
                        business(response.code, &response.msg)?;
                        let Some(pb::login_result::Result::Authenticated(authenticated)) =
                            response.data.and_then(|data| data.result)
                        else {
                            return Err(crate::Error::unavailable(
                                "服务器返回了无法建立会话的登录结果",
                            ));
                        };
                        session = Some(Session {
                            server: context.target.server.clone(),
                            authenticated,
                        });
                        rotated = true;
                        Ok(Phase::Complete)
                    }
                    Phase::Fresh { force, next } => {
                        let current = session.as_mut().ok_or_else(crate::Error::unauthenticated)?;
                        rotated = self.fresh(current, force, &context, access).await?;
                        let next = next.phase();
                        checkpoint = rotated && !matches!(next, Phase::Complete);
                        Ok(next)
                    }
                    Phase::Validate { confirm_rejection } => {
                        Access::check(access.current_user)?;
                        let current = session.as_mut().ok_or_else(crate::Error::unauthenticated)?;
                        if connect {
                            self.api
                                .connection
                                .set_target(context.target.clone(), now_ms);
                        }
                        let authentication = if connect {
                            self.api.connection.authenticate(cancel.clone()).await?
                        } else {
                            Authentication::Unavailable
                        };
                        if authentication == Authentication::Rejected && !confirm_rejection {
                            return Ok(Phase::Fresh {
                                force: true,
                                next: Next::Validate {
                                    confirm_rejection: true,
                                },
                            });
                        }
                        if authentication != Authentication::Authenticated {
                            context.options.transport = Transport::Http;
                        }
                        log::debug!(
                            "Account validating current user transport={}",
                            if authentication == Authentication::Authenticated {
                                "websocket"
                            } else {
                                "http"
                            }
                        );
                        let response = match self.api.current_user(&context).await {
                            Err(error) if error.code == 10002 && !confirm_rejection => {
                                return Ok(Phase::Fresh {
                                    force: true,
                                    next: Next::Validate {
                                        confirm_rejection: true,
                                    },
                                });
                            }
                            response => response?,
                        };
                        if response.code == 10002 && !confirm_rejection {
                            return Ok(Phase::Fresh {
                                force: true,
                                next: Next::Validate {
                                    confirm_rejection: true,
                                },
                            });
                        }
                        business(response.code, &response.msg)?;
                        let data = response.data.ok_or_else(|| {
                            crate::Error::unavailable("服务器返回了不匹配的账号信息")
                        })?;
                        if data.user.as_ref().map(|u| &u.user_id)
                            != current.authenticated.user.as_ref().map(|u| &u.user_id)
                            || data.device.as_ref().map(|d| &d.device_id)
                                != current.authenticated.device.as_ref().map(|d| &d.device_id)
                            || Some(&data.session_id)
                                != current.authenticated.tokens.as_ref().map(|t| &t.session_id)
                        {
                            return Err(crate::Error::unavailable("服务器返回了不匹配的账号信息"));
                        }
                        if cancel.is_cancelled() {
                            return Err(crate::Error::cancelled());
                        }
                        current.authenticated.user = data.user;
                        Ok(Phase::Complete)
                    }
                    Phase::Logout { retried } => {
                        Access::check(access.logout)?;
                        let response = match self.api.logout(&context).await {
                            Err(error) if error.code == 10002 && !retried => {
                                return Ok(Phase::Fresh {
                                    force: true,
                                    next: Next::Logout { retried: true },
                                });
                            }
                            response => response?,
                        };
                        if response.code == 10002 && !retried {
                            return Ok(Phase::Fresh {
                                force: true,
                                next: Next::Logout { retried: true },
                            });
                        }
                        business(response.code, &response.msg)?;
                        Ok(Phase::Complete)
                    }
                    Phase::Revoke => {
                        Access::check(access.logout)?;
                        let response = self.api.logout(&context).await?;
                        business(response.code, &response.msg)?;
                        Ok(Phase::Complete)
                    }
                }
            }
            .await;
            let mut state = self.state.lock().unwrap();
            if state.generation != generation {
                // Never expose the replacement target's credentials to an older operation.
                return Self::cancelled_outcome(session, now_ms);
            }
            // A rotation is retained before checking cancellation or the next network phase.
            if rotated {
                state.version += 1;
            }
            state.session = session;
            match action {
                Ok(next) => {
                    if cancel.is_cancelled() {
                        return Self::failure(&mut state, crate::Error::cancelled(), now_ms);
                    }
                    let complete = matches!(next, Phase::Complete);
                    state.pending.as_mut().unwrap().phase = next;
                    if complete || checkpoint {
                        return Self::result(&state, now_ms);
                    }
                }
                Err(error) => {
                    let logout = matches!(
                        phase,
                        Phase::Logout { .. }
                            | Phase::Fresh {
                                next: Next::Logout { .. },
                                ..
                            }
                    );
                    if logout && error.code == 10002 {
                        state.pending.as_mut().unwrap().phase = Phase::Complete;
                        return Self::result(&state, now_ms);
                    }
                    return Self::failure(&mut state, error, now_ms);
                }
            }
        }
    }

    fn cancelled_outcome(session: Option<Session>, now_ms: i64) -> Outcome {
        Outcome {
            code: 10008,
            message: "会话操作已取消".into(),
            session,
            credential_version: 0,
            checkpoint: false,
            next_maintenance_at_ms: now_ms + 30_000,
        }
    }
}
