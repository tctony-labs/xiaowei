use xiaowei_agent::{Agent, gateway};
use xw_agent::protocol::*;
use xw_agent_types::{ClientRequestId, SessionId};
use xw_gateway::{
    CallContext, ErrorCode, MethodKind, XwInvokeRegistry,
    binding::{Method, StreamMethod},
};

#[tokio::test]
async fn inactive_errors_not_found_and_shared_snapshots_use_registered_handlers() {
    let registry = XwInvokeRegistry::new();
    let agent = Agent::new();
    let owner = registry
        .register_owner("agent", gateway::registrations(&agent), vec![])
        .unwrap();
    let a = registry.client(CallContext::trusted("device-a"));
    let b = registry.client(CallContext::trusted("device-b"));
    let create = Method::<CreateSessionRequest, CreateSessionResponse>::new(
        "xiaowei.agent.Agent.CreateSession",
        MethodKind::Unary,
    );
    let subscribe = StreamMethod::<SubscribeSessionRequest, AgentEvent>::new("xiaowei.agent.Agent.SubscribeSession");
    let list =
        Method::<ListSessionsRequest, ListSessionsResponse>::new("xiaowei.agent.Agent.ListSessions", MethodKind::Unary);
    let request = CreateSessionRequest {
        title_model_ref: String::new(),
        client_request_id: ClientRequestId::new().to_string(),
        config: Some(AgentModelConfig {
            model_ref: "test".into(),
            reasoning: None,
        }),
    };
    assert_eq!(
        create.call(&a, request.clone()).await.unwrap_err().code,
        ErrorCode::OwnerUnavailable
    );
    // This test registry is the host; production obtains this identity from Endpoint::client().
    agent.activate(registry.client(CallContext::trusted("host-assigned-agent")));
    let created = create.call(&a, request.clone()).await.unwrap();
    let retried = create.call(&b, request).await.unwrap();
    assert_eq!(
        retried.session.as_ref().unwrap().session_id,
        created.session.as_ref().unwrap().session_id
    );
    assert_eq!(
        retried.session.as_ref().unwrap().config,
        created.session.as_ref().unwrap().config
    );
    assert_eq!(retried.session.as_ref().unwrap().metadata_revision, 1);
    let listed = list.call(&b, ListSessionsRequest::default()).await.unwrap().sessions;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].session_id, created.session.as_ref().unwrap().session_id);
    let invalid = subscribe
        .stream(
            &b,
            SubscribeSessionRequest {
                session_id: SessionId::new().to_string(),
            },
        )
        .await;
    assert!(matches!(invalid, Err(error) if error.code == ErrorCode::NotFound));
    let mut stream = subscribe
        .stream(
            &b,
            SubscribeSessionRequest {
                session_id: created.session.unwrap().session_id,
            },
        )
        .await
        .unwrap();
    use futures_util::StreamExt;
    assert!(matches!(
        stream.next().await.unwrap().unwrap().payload,
        Some(agent_event::Payload::SubscriptionReady(_))
    ));
    stream.cancel().await.unwrap();
    agent.close().await.unwrap();
    assert!(!agent.ready());
    assert_eq!(
        create.call(&a, CreateSessionRequest::default()).await.unwrap_err().code,
        ErrorCode::OwnerUnavailable
    );
    registry.unregister_owner(&owner);
}
