use futures_util::{SinkExt, StreamExt};
use prost::Message;
use proto_server_rs::xiaowei::server::{auth as pb, common::BaseResponse};
use std::sync::{Arc, Mutex};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::{accept_async, tungstenite::Message as SocketMessage};
use xw_api::{
    Client, RequestContext, Session, Target,
    connection::{Authentication, Status},
    contract::Method,
    wire::{self, Header, Manifest, Route, WireError},
};

struct Logs(Mutex<Vec<(log::Level, String)>>);

static LOGS: Logs = Logs(Mutex::new(Vec::new()));

impl log::Log for Logs {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }

    fn log(&self, record: &log::Record<'_>) {
        if record.target() == "xw_api::methods" {
            self.0
                .lock()
                .unwrap()
                .push((record.level(), record.args().to_string()));
        }
    }

    fn flush(&self) {}
}

enum Reply {
    Failure(WireError),
    Body(Vec<u8>),
    Pending(tokio::sync::oneshot::Sender<()>),
}

async fn fixture() -> (Arc<Client>, RequestContext, mpsc::UnboundedSender<Reply>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = format!("http://{}/private-path", listener.local_addr().unwrap());
    let (replies, mut pending) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(socket).await.unwrap();
        while let Some(Ok(SocketMessage::Binary(bytes))) = socket.next().await {
            let request = wire::decode(&bytes).unwrap();
            let mut response = Header::new("result");
            response.generation = "fixture".into();
            response.id = request.header.id;
            let mut payload = Vec::new();
            match request.header.op.as_str() {
                "authenticate" => {
                    let method =
                        Method::resolve("xiaowei.server.auth.Auth.GetCurrentUser").unwrap();
                    let mut route = Route::unary(&method);
                    route.input = "legacy.Empty".into();
                    route.timeout_ms = Some(30_000);
                    route.max_concurrency = Some(32);
                    response.op = "ready".into();
                    response.manifest = Some(Manifest {
                        routes: vec![route],
                        events: vec![],
                    });
                }
                "invoke" => match pending.recv().await.unwrap() {
                    Reply::Failure(error) => response.error = Some(error),
                    Reply::Body(bytes) => payload = bytes,
                    Reply::Pending(started) => {
                        let _ = started.send(());
                        continue;
                    }
                },
                "cancel" | "ping" => {}
                other => panic!("unexpected operation {other}"),
            }
            if socket
                .send(SocketMessage::Binary(
                    wire::encode(response, &payload, &[]).unwrap().into(),
                ))
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let context = RequestContext::new(Target {
        server: server.clone(),
        session: Some(Session {
            server,
            session_id: "private-session".into(),
            access_token: "private-token".into(),
            access_expires_at_ms: i64::MAX,
        }),
    });
    let client = Client::new().unwrap();
    client
        .connection
        .set_target(context.target.clone(), xw_api::now_ms());
    assert_eq!(
        client
            .connection
            .authenticate(context.cancellation.clone())
            .await
            .unwrap(),
        Authentication::Authenticated
    );
    (client, context, replies)
}

fn completed(level: log::Level, fields: &[&str]) {
    let logs = std::mem::take(&mut *LOGS.0.lock().unwrap());
    assert_eq!(logs.len(), 2, "{logs:?}");
    assert!(logs[0].1.starts_with("WebSocket request started "));
    assert_eq!(logs[1].0, level);
    for field in fields {
        assert!(logs[1].1.contains(field), "missing {field}: {logs:?}");
    }
    for (_, message) in logs {
        assert!(!message.contains("outcome="));
        assert!(!message.contains("private-"));
    }
}

#[tokio::test]
async fn connected_requests_log_original_errors_and_keep_the_socket_usable() {
    log::set_logger(&LOGS).unwrap();
    log::set_max_level(log::LevelFilter::Debug);
    let (client, context, replies) = fixture().await;

    for (code, message, expected_code, summary, level) in [
        (
            "INCOMPATIBLE",
            "route contract mismatch",
            10008,
            "客户端与服务器接口不兼容",
            log::Level::Warn,
        ),
        (
            "INVALID_ARGUMENT",
            "invalid request protobuf",
            10001,
            "服务器请求无效",
            log::Level::Warn,
        ),
        (
            "UNAUTHORIZED",
            "credential rejected",
            10002,
            "服务器拒绝了此操作",
            log::Level::Warn,
        ),
        (
            "UNKNOWN_ROUTE",
            "route missing",
            10004,
            "服务器未提供此接口",
            log::Level::Warn,
        ),
        (
            "CONCURRENCY_FULL",
            "method concurrency full",
            10007,
            "服务器请求过于频繁，请稍后重试",
            log::Level::Warn,
        ),
        (
            "TIMEOUT",
            "remote operation timed out",
            10008,
            "服务器请求超时，请稍后重试",
            log::Level::Warn,
        ),
        (
            "HANDLER_ERROR",
            "remote handler failed",
            10009,
            "服务器处理请求失败",
            log::Level::Error,
        ),
        (
            "OWNER_UNAVAILABLE",
            "service unavailable",
            10008,
            "服务器接口暂不可用",
            log::Level::Error,
        ),
        (
            "FUTURE_ERROR",
            "future failure",
            10008,
            "future failure",
            log::Level::Warn,
        ),
        (
            "FUTURE_EMPTY_ERROR",
            "",
            10008,
            "服务器请求失败",
            log::Level::Warn,
        ),
    ] {
        replies
            .send(Reply::Failure(WireError::new(code, message)))
            .unwrap();
        let error = client.current_user(&context).await.unwrap_err();
        assert_eq!(error.code, expected_code);
        assert_eq!(error.message, summary);
        completed(
            level,
            &[&format!("code={code}"), &format!("msg={message:?}")],
        );
        assert_eq!(
            client.connection.subscribe().borrow().status,
            Status::Connected
        );
    }

    let business = BaseResponse {
        code: 10008,
        msg: "数据库暂不可用".into(),
        data: None,
    };
    replies.send(Reply::Body(business.encode_to_vec())).unwrap();
    let response = client.current_user(&context).await.unwrap();
    assert_eq!(response.code, business.code);
    assert_eq!(response.msg, business.msg);
    completed(log::Level::Error, &["code=10008", "msg=\"数据库暂不可用\""]);

    for payload in [
        vec![255],
        BaseResponse {
            msg: "missing data".into(),
            ..Default::default()
        }
        .encode_to_vec(),
    ] {
        replies.send(Reply::Body(payload)).unwrap();
        let error = client.current_user(&context).await.unwrap_err();
        assert_eq!(error.message, "服务器返回了无效的响应");
        completed(
            log::Level::Error,
            &["error_code=10008", "error_msg=\"服务器返回了无效的响应\""],
        );
    }

    let (started, received) = tokio::sync::oneshot::channel();
    replies.send(Reply::Pending(started)).unwrap();
    let mut request = Box::pin(client.current_user(&context));
    tokio::select! {
        result = &mut request => panic!("request ended before cancellation: {result:?}"),
        _ = received => {}
    }
    drop(request);
    completed(
        log::Level::Debug,
        &["code=CANCELLED", "msg=\"request cancelled\""],
    );

    let response = pb::GetCurrentUserResponse {
        msg: "成功".into(),
        data: Some(pb::GetCurrentUserData {
            user: Some(pb::UserSnapshot {
                user_id: "u_fixture".into(),
                ..Default::default()
            }),
            device: Some(pb::DeviceSnapshot {
                device_id: "d_fixture".into(),
                ..Default::default()
            }),
            session_id: "s_fixture".into(),
        }),
        ..Default::default()
    };
    replies.send(Reply::Body(response.encode_to_vec())).unwrap();
    assert_eq!(client.current_user(&context).await.unwrap(), response);
    completed(
        log::Level::Debug,
        &["method=auth.Auth/GetCurrentUser", "code=0", "msg=\"成功\""],
    );
    assert_eq!(
        client.connection.subscribe().borrow().status,
        Status::Connected
    );
    client.close().await;
}
