use std::sync::Arc;

use futures_util::{StreamExt, stream};
use xw_agent::{AgentError, InputSource, SourceKind};
use xw_gateway::{ErrorCode, GatewayError, InvokeRegistration};

use crate::{Agent, gateway_binding::xiaowei_agent_agent_service as api};

fn ready(agent: &Agent) -> Result<(), GatewayError> {
    if agent.ready() {
        Ok(())
    } else {
        Err(GatewayError::new(
            ErrorCode::OwnerUnavailable,
            "agent endpoint inactive",
        ))
    }
}

pub fn error(error: AgentError) -> GatewayError {
    let code = match error {
        AgentError::InvalidArgument(_) => ErrorCode::InvalidArgument,
        AgentError::NotFound(_) => ErrorCode::NotFound,
        AgentError::SessionUnavailable => ErrorCode::Conflict,
        AgentError::Conflict(_) => ErrorCode::Conflict,
        AgentError::ResourceExhausted(_) => ErrorCode::ResourceExhausted,
        AgentError::Closed | AgentError::ExecutionUnavailable => ErrorCode::OwnerUnavailable,
        AgentError::Internal | AgentError::Persistence | AgentError::Index | AgentError::TitleGeneration(_) => {
            ErrorCode::HandlerError
        }
    };
    GatewayError::new(code, error.to_string())
}

pub fn registrations(agent: &Arc<Agent>) -> Vec<InvokeRegistration> {
    let create = agent.clone();
    let archive = agent.clone();
    let list = agent.clone();
    let read = agent.clone();
    let set_title = agent.clone();
    let set_config = agent.clone();
    let delete = agent.clone();
    let title = agent.clone();
    let start = agent.clone();
    let interrupt = agent.clone();
    let get_policy = agent.clone();
    let set_policy = agent.clone();
    let viewing = agent.clone();
    let subscribe = agent.clone();
    let mut subscription = api::SUBSCRIBE_SESSION.handler(move |request, _| {
        let agent = subscribe.clone();
        async move {
            ready(&agent)?;
            let subscription = agent.service.subscribe_session(request).await.map_err(error)?;
            Ok(stream::unfold(subscription, |mut subscription| async {
                let event = subscription.recv().await?;
                Some((
                    event.map_err(|_| {
                        GatewayError::new(ErrorCode::ResourceExhausted, "agent subscriber lagged; resubscribe")
                    }),
                    subscription,
                ))
            }))
        }
    });
    // An idle session is a valid observation. No fake business heartbeat or revision.
    // The transport still bounds chunks, pull buffering and abandoned consumers.
    subscription.stream_policy.producer_idle_ms = 2_147_483_647;
    subscription.stream_policy.queue_bytes = 1024 * 1024;
    let mut viewing = api::TRACK_SESSION_VIEWING.handler(move |request, _| {
        let agent = viewing.clone();
        async move {
            ready(&agent)?;
            let lease = agent.service.track_session_viewing(request).await.map_err(error)?;
            let stream = stream::once(async { Ok(xw_agent::protocol::SessionViewingReady {}) }).chain(stream::unfold(
                lease,
                |lease| async move {
                    // Keep protection until the transport drops the cancelled stream.
                    std::future::pending::<()>().await;
                    Some((Ok(xw_agent::protocol::SessionViewingReady {}), lease))
                },
            ));
            Ok(stream)
        }
    });
    viewing.stream_policy.producer_idle_ms = 2_147_483_647;
    vec![
        api::CREATE_SESSION.handler(move |request, client| {
            let agent = create.clone();
            async move {
                ready(&agent)?;
                agent
                    .service
                    .create_session_with_source(
                        request,
                        InputSource {
                            kind: SourceKind::Desktop,
                            principal_id: client.context().caller().to_owned(),
                        },
                    )
                    .await
                    .map_err(error)
            }
        }),
        api::LIST_SESSIONS.handler(move |request, _| {
            let agent = list.clone();
            async move {
                ready(&agent)?;
                agent.service.list_sessions(request).await.map_err(error)
            }
        }),
        api::READ_SESSION.handler(move |request, _| {
            let agent = read.clone();
            async move {
                ready(&agent)?;
                agent.service.read_session(request).await.map_err(error)
            }
        }),
        api::SET_SESSION_CONFIG.handler(move |request, _| {
            let agent = set_config.clone();
            async move {
                ready(&agent)?;
                agent.service.set_session_config(request).await.map_err(error)
            }
        }),
        api::SET_SESSION_TITLE.handler(move |request, _| {
            let agent = set_title.clone();
            async move {
                ready(&agent)?;
                agent.service.set_session_title(request).await.map_err(error)
            }
        }),
        api::SET_SESSION_ARCHIVED.handler(move |request, _| {
            let agent = archive.clone();
            async move {
                ready(&agent)?;
                agent.service.set_session_archived(request).await.map_err(error)
            }
        }),
        api::DELETE_SESSION.handler(move |request, _| {
            let agent = delete.clone();
            async move {
                ready(&agent)?;
                agent.service.delete_session(request).await.map_err(error)
            }
        }),
        api::REGENERATE_TITLE.handler(move |request, _| {
            let agent = title.clone();
            async move {
                ready(&agent)?;
                agent.service.regenerate_title(request).await.map_err(error)
            }
        }),
        subscription,
        viewing,
        api::GET_SESSION_RETENTION_POLICY.handler(move |_, _| {
            let agent = get_policy.clone();
            async move {
                ready(&agent)?;
                agent.service.get_session_retention_policy().await.map_err(error)
            }
        }),
        api::SET_SESSION_RETENTION_POLICY.handler(move |request, _| {
            let agent = set_policy.clone();
            async move {
                ready(&agent)?;
                agent.service.set_session_retention_policy(request).await.map_err(error)
            }
        }),
        api::START_RUN.handler(move |request, client| {
            let agent = start.clone();
            async move {
                ready(&agent)?;
                agent
                    .service
                    .start_run(
                        request,
                        InputSource {
                            kind: SourceKind::Desktop,
                            principal_id: client.context().caller().to_owned(),
                        },
                    )
                    .await
                    .map_err(error)
            }
        }),
        api::INTERRUPT_RUN.handler(move |request, _| {
            let agent = interrupt.clone();
            async move {
                ready(&agent)?;
                agent.service.interrupt_run(request).map_err(error)
            }
        }),
    ]
}
