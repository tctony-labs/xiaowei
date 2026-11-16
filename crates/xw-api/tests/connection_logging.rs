use futures_util::{SinkExt, StreamExt};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::{
    accept_async,
    tungstenite::{Message, protocol::CloseFrame, protocol::frame::coding::CloseCode},
};
use tokio_util::sync::CancellationToken;
use xw_api::{
    Session, Target,
    connection::{Authentication, Connection},
    websocket::Peer,
    wire::{self, Header, Manifest, WireError},
};

struct Logs(Mutex<Vec<String>>);

static LOGS: Logs = Logs(Mutex::new(Vec::new()));
static NEXT_ID: AtomicUsize = AtomicUsize::new(1);

impl log::Log for Logs {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }

    fn log(&self, record: &log::Record<'_>) {
        if matches!(record.target(), "xw_api::websocket" | "xw_api::connection") {
            self.0
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(record.args().to_string());
        }
    }

    fn flush(&self) {}
}

enum Action {
    Drop,
    Close,
    Reject,
    Malformed,
}

struct Fixture {
    url: String,
    actions: mpsc::UnboundedSender<Action>,
    task: tokio::task::JoinHandle<()>,
}

impl Fixture {
    async fn start(ignore_ping: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (actions, mut incoming) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(socket).await.unwrap();
                let auth = socket.next().await.unwrap().unwrap();
                assert!(matches!(auth, Message::Binary(_)));
                let id = format!("logging-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
                let mut ready = Header::new("ready");
                ready.generation = id.clone();
                ready.manifest = Some(Manifest::default());
                socket
                    .send(Message::Binary(
                        wire::encode(ready, &[], &[]).unwrap().into(),
                    ))
                    .await
                    .unwrap();
                loop {
                    tokio::select! {
                        action = incoming.recv() => {
                            match action.unwrap() {
                                Action::Drop => {}
                                Action::Close => {
                                    let _ = socket.send(Message::Close(Some(CloseFrame {
                                        code: CloseCode::Normal,
                                        reason: "private-close-reason".into(),
                                    }))).await;
                                }
                                Action::Reject => {
                                    let mut end = Header::new("connection.end");
                                    end.generation = id.clone();
                                    end.error = Some(WireError::new(
                                        "UNAUTHORIZED", "session revoked",
                                    ));
                                    let bytes = wire::encode(end, &[], &[]).unwrap();
                                    let _ = socket.send(Message::Binary(bytes.into())).await;
                                }
                                Action::Malformed => {
                                    let _ = socket.send(Message::Binary(
                                        b"private-payload".to_vec().into(),
                                    )).await;
                                }
                            }
                            break;
                        }
                        message = socket.next() => {
                            let Some(Ok(Message::Binary(bytes))) = message else { break };
                            let frame = wire::decode(&bytes).unwrap();
                            if frame.header.op == "ping" && !ignore_ping {
                                let mut pong = Header::new("result");
                                pong.generation = id.clone();
                                pong.id = frame.header.id;
                                let bytes = wire::encode(pong, &[], &[]).unwrap();
                                if socket.send(Message::Binary(bytes.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        });
        Self { url, actions, task }
    }

    fn target(&self) -> Target {
        let server = self.url.replace("ws:", "http:");
        Target {
            server: server.clone(),
            session: Some(Session {
                server,
                session_id: "private-session".into(),
                access_token: "private-token".into(),
                access_expires_at_ms: i64::MAX,
            }),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn close_record(id: &str, source: &str) -> String {
    let logs = LOGS.0.lock().unwrap();
    let records: Vec<_> = logs
        .iter()
        .filter(|message| {
            message.starts_with(&format!("Server WebSocket closed connection_id={id} "))
        })
        .collect();
    assert_eq!(records.len(), 1, "{logs:?}");
    let record = records[0];
    for field in [
        format!("source={source} "),
        "duration_ms=".into(),
        "last_received_ms=".into(),
        "last_sent_ms=".into(),
        "pending_requests=".into(),
        "queued_bytes=".into(),
    ] {
        assert!(record.contains(&field), "missing {field}: {record}");
    }
    record.clone()
}

#[tokio::test]
async fn connection_logs_correlate_closes_retries_and_heartbeat_failures() {
    log::set_logger(&LOGS).unwrap();
    log::set_max_level(log::LevelFilter::Debug);

    for (action, source) in [
        (Action::Drop, "read"),
        (Action::Close, "remote_close"),
        (Action::Reject, "connection_end"),
        (Action::Malformed, "decode"),
    ] {
        let fixture = Fixture::start(false).await;
        let peer = Peer::connect(&fixture.url, "private-token", CancellationToken::new())
            .await
            .unwrap();
        peer.ping().await.unwrap();
        fixture.actions.send(action).unwrap();
        let error = tokio::time::timeout(Duration::from_secs(2), peer.closed())
            .await
            .unwrap();
        peer.close();
        let record = close_record(&peer.generation, source);
        assert!(record.contains(&format!("code={}", error.code)));
        if source == "remote_close" {
            assert!(record.contains("1000"), "{record}");
        }
    }

    let fixture = Fixture::start(false).await;
    let connection = Connection::new();
    connection.set_target(fixture.target(), xw_api::now_ms());
    let mut connection_ids = Vec::new();
    for attempt in 0..2 {
        let mut updates = connection.subscribe();
        tokio::time::timeout(Duration::from_secs(2), async {
            while updates.borrow_and_update().status != xw_api::connection::Status::Connected {
                updates.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(
            connection
                .authenticate(CancellationToken::new())
                .await
                .unwrap(),
            Authentication::Authenticated,
        );
        let connected = LOGS
            .0
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message.starts_with("Server WebSocket connected "))
            .unwrap()
            .clone();
        let id = connected
            .split_whitespace()
            .find_map(|field| field.strip_prefix("connection_id="))
            .unwrap()
            .to_string();
        assert!(connected.contains("server=http://127.0.0.1:"));
        connection_ids.push(id.clone());
        if attempt == 0 {
            fixture.actions.send(Action::Drop).unwrap();
            let mut updates = connection.subscribe();
            tokio::time::timeout(Duration::from_secs(2), async {
                while updates.borrow_and_update().status == xw_api::connection::Status::Connected {
                    updates.changed().await.unwrap();
                }
            })
            .await
            .unwrap();
        } else {
            connection.set_target(Target::default(), xw_api::now_ms());
            close_record(&id, "target_changed");
        }
    }
    assert_ne!(connection_ids[0], connection_ids[1]);
    assert!(LOGS.0.lock().unwrap().iter().any(|message| {
        message.starts_with("Server WebSocket disconnected ")
            && message.contains(&format!("connection_id={} ", connection_ids[0]))
            && message.contains("retry_ms=500")
    }));
    connection.close().await;

    let fixture = Fixture::start(true).await;
    let connection = Connection::new();
    connection.set_target(fixture.target(), xw_api::now_ms());
    connection
        .authenticate(CancellationToken::new())
        .await
        .unwrap();
    let heartbeat = tokio::time::timeout(Duration::from_secs(22), async {
        loop {
            let message = LOGS
                .0
                .lock()
                .unwrap()
                .iter()
                .find(|message| message.starts_with("Server WebSocket heartbeat failed "))
                .cloned();
            if let Some(message) = message {
                break message;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(heartbeat.contains("code=TIMEOUT"), "{heartbeat}");
    let id = heartbeat
        .split_whitespace()
        .find_map(|field| field.strip_prefix("connection_id="))
        .unwrap();
    close_record(id, "heartbeat_failed");
    connection.close().await;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let stalled = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(socket).await.unwrap();
        let _ = socket.next().await;
        // Keep the socket open while withholding the authenticated ready response.
        std::future::pending::<()>().await;
    });
    let error = Peer::connect(&url, "private-token", CancellationToken::new())
        .await
        .err()
        .unwrap();
    stalled.abort();
    assert_eq!(error.code, "TIMEOUT");
    assert!(LOGS.0.lock().unwrap().iter().any(|message| {
        message.starts_with("Server WebSocket connection failed ")
            && message.contains("phase=ready_read")
            && message.contains("code=TIMEOUT")
    }));

    for message in LOGS.0.lock().unwrap().iter() {
        assert!(
            !message.contains("private-"),
            "sensitive data logged: {message}"
        );
    }
}
