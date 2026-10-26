mod support;

use prost::Message;
use proto_testing_rs::testing::{Changed, Envelope};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use xw_api::{
    Session, Target,
    connection::{Authentication, Connection, Status},
    websocket::Peer,
    wire::{self, Route},
};

fn request(text: &str, id: u64) -> Vec<u8> {
    Envelope {
        text: text.into(),
        id,
        ..Default::default()
    }
    .encode_to_vec()
}

fn route(name: &str, streaming: bool) -> Route {
    Route {
        name: format!("testing.Fixture.{name}"),
        kind: if streaming {
            "serverStreaming"
        } else {
            "unary"
        }
        .into(),
        control_version: 3,
        contract_version: 1,
        input: "testing.Envelope".into(),
        output: if streaming {
            "testing.Changed"
        } else {
            "testing.Envelope"
        }
        .into(),
        timeout_ms: None,
        max_concurrency: None,
        stream_policy: None,
        options_schema: None,
    }
}

async fn echo(peer: &Arc<Peer>, text: &str) -> Envelope {
    let bytes = peer
        .invoke(
            route("Echo", false),
            request(text, 42),
            5000,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    Envelope::decode(bytes.as_slice()).unwrap()
}

#[tokio::test]
async fn real_go_pb_routing_limits_and_empty_client_exports() {
    let fixture = support::Fixture::start();
    let peer = Peer::connect(&fixture.url, "fixture", CancellationToken::new())
        .await
        .unwrap();
    let mut input = Envelope {
        id: u64::MAX,
        text: "中文".into(),
        ..Default::default()
    };
    input.blobs.push(proto_testing_rs::testing::envelope::Blob {
        data: vec![173; 2 * 1024 * 1024],
    });
    let bytes = peer
        .invoke(
            route("Echo", false),
            input.encode_to_vec(),
            5000,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(Envelope::decode(bytes.as_slice()).unwrap(), input);
    assert!(peer.can_invoke(&route("Echo", false)));
    let mut wrong = route("Echo", false);
    wrong.output = "wrong.Output".into();
    assert!(!peer.can_invoke(&wrong));
    assert_eq!(
        peer.invoke(wrong, vec![], 5000, CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        "INCOMPATIBLE"
    );
    assert_eq!(
        peer.invoke(
            route("Missing", false),
            vec![],
            5000,
            CancellationToken::new()
        )
        .await
        .unwrap_err()
        .code,
        "UNKNOWN_ROUTE"
    );
    assert_eq!(
        peer.invoke(
            route("Echo", false),
            vec![0; wire::MAX_PAYLOAD + 1],
            5000,
            CancellationToken::new()
        )
        .await
        .unwrap_err()
        .code,
        "RESOURCE_EXHAUSTED"
    );
    assert_eq!(
        peer.invoke(
            route("Echo", false),
            request("failure", 1),
            5000,
            CancellationToken::new()
        )
        .await
        .unwrap_err()
        .code,
        "INVALID_ARGUMENT"
    );
    peer.ping().await.unwrap();
    peer.close();
    assert!(!peer.can_invoke(&route("Echo", false)));
    assert!(
        Peer::connect(&fixture.url, "wrong", CancellationToken::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn streams_interleave_cancel_and_report_producer_and_idle_failures() {
    let fixture = support::Fixture::start();
    let peer = Peer::connect(&fixture.url, "fixture", CancellationToken::new())
        .await
        .unwrap();
    let mut a = peer
        .stream(
            route("Watch", true),
            &request("", 0),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let mut b = peer
        .stream(
            route("Watch", true),
            &request("", 0),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    for i in 1..=3 {
        let a = a.next().await.unwrap().unwrap();
        let b = b.next().await.unwrap().unwrap();
        assert_eq!(Changed::decode(a.as_slice()).unwrap().value.unwrap().id, i);
        assert_eq!(Changed::decode(b.as_slice()).unwrap().value.unwrap().id, i);
    }
    assert!(a.next().await.unwrap().is_none());
    assert!(b.next().await.unwrap().is_none());
    let mut failed = peer
        .stream(
            route("Watch", true),
            &request("fail", 0),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    failed.next().await.unwrap();
    assert_eq!(failed.next().await.unwrap_err().code, "INVALID_ARGUMENT");
    assert_eq!(failed.next().await.unwrap_err().code, "INVALID_ARGUMENT");
    let mut idle = peer
        .stream(
            route("Watch", true),
            &request("", 0),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(idle.next().await.unwrap_err().code, "TIMEOUT");
    let cancel = CancellationToken::new();
    let mut blocked = peer
        .stream(
            route("Watch", true),
            &request("nextwait", 0),
            cancel.clone(),
        )
        .await
        .unwrap();
    let work = blocked.next();
    let abort = async {
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel.cancel();
    };
    let (result, _) = tokio::join!(work, abort);
    assert_eq!(result.unwrap_err().code, "CANCELLED");
    assert_eq!(blocked.next().await.unwrap_err().code, "CANCELLED");
    let cancel = CancellationToken::new();
    let opening = request("openwait", 0);
    let work = peer.stream(route("Watch", true), &opening, cancel.clone());
    let abort = async {
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel.cancel();
    };
    let (result, _) = tokio::join!(work, abort);
    assert!(result.is_err());
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(echo(&peer, "active").await.id, 0);
    peer.close();
}

#[tokio::test]
async fn subscriptions_filter_acknowledge_unsubscribe_and_bound_slow_consumers() {
    let fixture = support::Fixture::start();
    let peer = Peer::connect(&fixture.url, "fixture", CancellationToken::new())
        .await
        .unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let sink = Arc::new(move |bytes| {
        let tx = tx.clone();
        Box::pin(async move {
            tx.send(bytes).unwrap();
            Ok(())
        }) as _
    });
    let subscription = peer
        .subscribe("testing.Changed", &request("", 9), sink)
        .await
        .unwrap();
    peer.invoke(
        route("Echo", false),
        request("publish", 8),
        5000,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(rx.try_recv().is_err());
    peer.invoke(
        route("Echo", false),
        request("publish", 9),
        5000,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let bytes = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        Changed::decode(bytes.as_slice()).unwrap().value.unwrap().id,
        9
    );
    let bad = peer
        .subscribe(
            "testing.Changed",
            &[255],
            Arc::new(|_| Box::pin(async { Ok(()) })),
        )
        .await;
    assert!(matches!(bad, Err(error) if error.code == "INVALID_ARGUMENT"));
    drop(subscription);
    peer.ping().await.unwrap();
    peer.invoke(
        route("Echo", false),
        request("publish", 9),
        5000,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(rx.try_recv().is_err());
    let _slow = peer
        .subscribe(
            "testing.Changed",
            &request("", 42),
            Arc::new(|_| Box::pin(std::future::pending())),
        )
        .await
        .unwrap();
    for _ in 0..40 {
        if peer
            .invoke(
                route("Echo", false),
                request("publish", 42),
                5000,
                CancellationToken::new(),
            )
            .await
            .is_err()
        {
            break;
        }
    }
    tokio::time::timeout(Duration::from_secs(2), peer.closed())
        .await
        .unwrap();
}

#[tokio::test]
async fn cancellation_reaches_go_and_close_terminates_inflight_requests() {
    let fixture = support::Fixture::start();
    let peer = Peer::connect(&fixture.url, "fixture", CancellationToken::new())
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    let call = peer.invoke(
        route("Echo", false),
        request("wait", 0),
        5000,
        cancel.clone(),
    );
    let abort = async {
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel.cancel();
    };
    let (result, _) = tokio::join!(call, abort);
    assert_eq!(result.unwrap_err().code, "CANCELLED");
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(echo(&peer, "active").await.id, 0);
    let call = peer.invoke(
        route("Echo", false),
        request("wait", 0),
        5000,
        CancellationToken::new(),
    );
    let stop = async {
        tokio::task::yield_now().await;
        peer.close();
    };
    let (result, _) = tokio::join!(call, stop);
    assert_eq!(result.unwrap_err().code, "OWNER_UNAVAILABLE");
}

#[tokio::test]
async fn connection_rotates_retries_and_isolates_previous_credentials() {
    let fixture = support::Fixture::start();
    let server = fixture.url.replace("ws:", "http:");
    let connection = Connection::new();
    let mut target = Target {
        server: server.clone(),
        session: Some(Session {
            server: server.clone(),
            session_id: "first".into(),
            access_token: "fixture".into(),
            access_expires_at_ms: xw_api::now_ms() + 60_000,
        }),
    };
    connection.set_target(target.clone(), xw_api::now_ms());
    assert_eq!(
        connection
            .authenticate(CancellationToken::new())
            .await
            .unwrap(),
        Authentication::Authenticated
    );
    let peer = connection.peer(&route("Echo", false), &target).unwrap();
    assert!(
        peer.invoke(
            route("Echo", false),
            request("disconnect", 0),
            5000,
            CancellationToken::new()
        )
        .await
        .is_err()
    );
    let mut updates = connection.subscribe();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if updates.borrow_and_update().status == Status::Connected
                && connection.can_invoke(&route("Echo", false), &target)
            {
                break;
            }
            updates.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    let previous = target.clone();
    target.session.as_mut().unwrap().session_id = "second".into();
    connection.set_target(target.clone(), xw_api::now_ms());
    assert!(!connection.can_invoke(&route("Echo", false), &previous));
    assert_eq!(
        connection
            .authenticate(CancellationToken::new())
            .await
            .unwrap(),
        Authentication::Authenticated
    );
    target.session.as_mut().unwrap().access_token = "rejected".into();
    connection.set_target(target.clone(), xw_api::now_ms());
    assert_eq!(
        connection
            .authenticate(CancellationToken::new())
            .await
            .unwrap(),
        Authentication::Rejected
    );
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(connection.subscribe().borrow().status, Status::Disconnected);
    connection.close().await;
    connection.close().await;
    assert!(!connection.can_invoke(&route("Echo", false), &target));
}
