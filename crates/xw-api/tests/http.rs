use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};
use xw_api::{Client, RequestContext, Session, Target};
use xw_api::{RequestOptions, Transport};

async fn server(reply: Vec<u8>, wait: Duration) -> (String, oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}/proxy", listener.local_addr().unwrap());
    let (tx, rx) = oneshot::channel();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut buffer = [0u8; 4096];
            let count = socket.read(&mut buffer).await.unwrap();
            if count == 0 {
                return;
            }
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let size = headers
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|v| v.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + size {
                    break;
                }
            }
        }
        let _ = tx.send(String::from_utf8(bytes).unwrap());
        tokio::time::sleep(wait).await;
        let _ = socket.write_all(&reply).await;
    });
    (address, rx)
}

fn reply(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

const HEALTH: &str = "xiaowei.server.Health.Check";

#[tokio::test]
async fn real_http_has_short_paths_no_public_bearer_and_bounded_bodies() {
    let client = Client::new().unwrap();
    let (url, received) = server(reply(r#"{"code":0,"msg":"ok","data":{}}"#), Duration::ZERO).await;
    let mut context = RequestContext::new(Target {
        server: url.clone(),
        session: Some(Session {
            server: url,
            session_id: "session".into(),
            access_token: "private".into(),
            access_expires_at_ms: i64::MAX,
        }),
    });
    client.invoke(HEALTH, &[], &context).await.unwrap();
    let request = received.await.unwrap();
    assert!(request.starts_with("POST /proxy/api/Health/Check HTTP/1.1"));
    assert!(!request.to_lowercase().contains("authorization"));
    let (url, _) = server(reply(&"a".repeat(65537)), Duration::ZERO).await;
    context.target.server = url;
    assert_eq!(
        client
            .invoke(HEALTH, &[], &context)
            .await
            .unwrap_err()
            .category,
        "response_too_large"
    );
    client.close().await;
}

#[tokio::test]
async fn redirect_never_reaches_another_server_with_credentials() {
    let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let response = format!(
        "HTTP/1.1 302 Found\r\nLocation: http://{}/target\r\nContent-Length: 0\r\n\r\n",
        destination.local_addr().unwrap()
    );
    let (url, received) = server(response.into_bytes(), Duration::ZERO).await;
    let client = Client::new().unwrap();
    let context = RequestContext::new(Target {
        server: url.clone(),
        session: Some(Session {
            server: url,
            session_id: "session".into(),
            access_token: "private".into(),
            access_expires_at_ms: i64::MAX,
        }),
    });
    assert!(client.current_user(&context).await.is_err());
    assert!(received.await.unwrap().contains("Bearer private"));
    assert!(
        tokio::time::timeout(Duration::from_millis(30), destination.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn cancellation_timeout_zero_and_transport_validation_use_real_network() {
    let client = Client::new().unwrap();
    let success = reply(r#"{"code":0,"msg":"ok","data":{}}"#);
    let (url, _) = server(success.clone(), Duration::from_millis(80)).await;
    let mut context = RequestContext::new(Target {
        server: url,
        session: None,
    });
    context.options.timeout_ms = Some(20);
    assert_eq!(
        client
            .invoke(HEALTH, &[], &context)
            .await
            .unwrap_err()
            .category,
        "timeout"
    );
    let (url, received) = server(success.clone(), Duration::from_secs(10)).await;
    context.target.server = url;
    let cancel = context.cancellation.clone();
    let work = client.invoke(HEALTH, &[], &context);
    let abort = async {
        received.await.unwrap();
        cancel.cancel();
    };
    let (result, _) = tokio::join!(work, abort);
    assert_eq!(result.unwrap_err().category, "cancelled");
    let (url, _) = server(success, Duration::from_millis(80)).await;
    context = RequestContext::new(Target {
        server: url,
        session: None,
    });
    context.options = RequestOptions {
        timeout_ms: Some(0),
        transport: Transport::Auto,
    };
    client.invoke(HEALTH, &[], &context).await.unwrap();
    context.options.timeout_ms = Some(i32::MAX as u32 + 1);
    assert_eq!(
        client.invoke(HEALTH, &[], &context).await.unwrap_err().code,
        10001
    );
}

#[tokio::test]
async fn omitted_timeout_really_expires_after_fifteen_seconds() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let context = RequestContext::new(Target {
        server: format!("http://{}", listener.local_addr().unwrap()),
        session: None,
    });
    let client = Client::new().unwrap();
    let request = tokio::spawn(async move { client.invoke(HEALTH, &[], &context).await });
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut bytes = [0; 4096];
    socket.read(&mut bytes).await.unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_millis(14900)).await;
    assert!(!request.is_finished());
    tokio::time::advance(Duration::from_millis(101)).await;
    assert_eq!(request.await.unwrap().unwrap_err().category, "timeout");
}
