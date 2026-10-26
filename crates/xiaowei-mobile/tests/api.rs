mod support;

use prost::Message;
use proto_server_rs::xiaowei::server::common::BaseResponse;
use xiaowei_mobile::{LocalErrorKind, MobileClient, MobileError, RequestOptions};

const HEALTH: &str = "xiaowei.server.common.Health.Check";

#[tokio::test]
async fn repeated_reads_do_not_replay_and_immediate_cancel_sends_nothing() {
    let server = support::Server::start().await;
    let client = MobileClient::new().unwrap();
    let call = client
        .invoke(
            server.context(false, false),
            HEALTH.into(),
            vec![],
            RequestOptions::default(),
        )
        .unwrap();
    let first = call.run().await.unwrap();
    assert_eq!(BaseResponse::decode(first.as_slice()).unwrap().code, 0);
    assert_eq!(call.run().await.unwrap(), first);
    assert_eq!(server.counts.lock().unwrap().health, 1);
    call.close().await;

    let cancelled = client
        .invoke(
            server.context(false, false),
            HEALTH.into(),
            vec![],
            RequestOptions::default(),
        )
        .unwrap();
    cancelled.cancel();
    assert!(
        matches!(cancelled.run().await, Err(MobileError::Core { category, .. })
        if category == "cancelled")
    );
    assert_eq!(server.counts.lock().unwrap().health, 1);
    cancelled.close().await;
    client.close().await.unwrap();
    client.close().await.unwrap();
    assert!(matches!(
        client.invoke(
            server.context(false, false),
            HEALTH.into(),
            vec![],
            RequestOptions::default(),
        ),
        Err(MobileError::Local {
            kind: LocalErrorKind::Closed,
            ..
        })
    ));
}

#[tokio::test]
async fn cancellation_and_client_close_wait_for_live_requests() {
    let server = support::Server::start().await;
    server.counts.lock().unwrap().pause_health = true;
    let client = MobileClient::new().unwrap();
    let call = client
        .invoke(
            server.context(false, false),
            HEALTH.into(),
            vec![],
            RequestOptions::default(),
        )
        .unwrap();
    let running = tokio::spawn({
        let call = call.clone();
        async move { call.run().await }
    });
    server.received.notified().await;
    call.cancel();
    assert!(
        matches!(running.await.unwrap(), Err(MobileError::Core { category, .. })
        if category == "cancelled")
    );
    call.close().await;
    server.disconnected.notified().await;

    let call = client
        .invoke(
            server.context(false, false),
            HEALTH.into(),
            vec![],
            RequestOptions::default(),
        )
        .unwrap();
    let running = tokio::spawn({
        let call = call.clone();
        async move { call.run().await }
    });
    server.received.notified().await;
    // Dropping the foreign wait does not detach work from the owning client.
    running.abort();
    drop(call);
    client.close().await.unwrap();
    server.disconnected.notified().await;
    assert_eq!(server.counts.lock().unwrap().health, 2);
}

#[tokio::test]
async fn timeout_preserves_the_core_category() {
    let server = support::Server::start().await;
    server.counts.lock().unwrap().pause_health = true;
    let client = MobileClient::new().unwrap();
    let call = client
        .invoke(
            server.context(false, false),
            HEALTH.into(),
            vec![],
            RequestOptions {
                timeout_ms: Some(30),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        matches!(call.run().await, Err(MobileError::Core { category, .. })
        if category == "timeout")
    );
    client.close().await.unwrap();
}

#[tokio::test]
async fn http_business_failures_keep_the_protobuf_response_contract() {
    let server = support::Server::start().await;
    server.counts.lock().unwrap().health_code = 10001;
    let client = MobileClient::new().unwrap();
    let call = client
        .invoke(
            server.context(false, false),
            HEALTH.into(),
            vec![],
            RequestOptions::default(),
        )
        .unwrap();
    let bytes = call.run().await.unwrap();
    let response = BaseResponse::decode(bytes.as_slice()).unwrap();
    assert_eq!(response.code, 10001);
    assert!(response.data.is_none());
    client.close().await.unwrap();
}
