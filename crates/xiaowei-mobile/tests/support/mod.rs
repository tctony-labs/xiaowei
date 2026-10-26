use prost::Message;
use proto_server_rs::xiaowei::server::auth as pb;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
};
use tokio_util::sync::CancellationToken;
use xiaowei_mobile::SessionContext;

#[derive(Default)]
pub struct Counts {
    pub health: usize,
    pub refresh: usize,
    pub user: usize,
    pub logout: usize,
    pub login: usize,
    pub user_code: i32,
    pub pause_health: bool,
    pub health_code: i32,
}

pub struct Server {
    pub url: String,
    pub counts: Arc<Mutex<Counts>>,
    // These signals are consumed by the API tests, not the account test binary.
    #[allow(dead_code)]
    pub received: Arc<Notify>,
    #[allow(dead_code)]
    pub disconnected: Arc<Notify>,
    stop: CancellationToken,
    now: i64,
}

impl Server {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let counts = Arc::new(Mutex::new(Counts::default()));
        let received = Arc::new(Notify::new());
        let disconnected = Arc::new(Notify::new());
        let stop = CancellationToken::new();
        let now = xw_api::now_ms();
        let result = Self {
            url,
            counts: counts.clone(),
            received: received.clone(),
            disconnected: disconnected.clone(),
            stop: stop.clone(),
            now,
        };
        tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = stop.cancelled() => return,
                    accepted = listener.accept() => accepted.unwrap(),
                };
                let (mut socket, _) = accepted;
                let counts = counts.clone();
                let received = received.clone();
                let disconnected = disconnected.clone();
                let stop = stop.clone();
                tokio::spawn(async move {
                    let mut bytes = Vec::new();
                    loop {
                        let mut chunk = [0; 4096];
                        let count = socket.read(&mut chunk).await.unwrap_or(0);
                        if count == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&chunk[..count]);
                        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                            let header = String::from_utf8_lossy(&bytes[..end]);
                            let length = header
                                .lines()
                                .find_map(|line| {
                                    line.to_lowercase()
                                        .strip_prefix("content-length: ")?
                                        .parse()
                                        .ok()
                                })
                                .unwrap_or(0usize);
                            if bytes.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    let header = String::from_utf8_lossy(&bytes);
                    let (code, data, pause) = {
                        let mut counts = counts.lock().unwrap();
                        if header.starts_with("POST /api/common.Health/Check ") {
                            counts.health += 1;
                            (
                                counts.health_code,
                                serde_json::json!({}),
                                counts.pause_health,
                            )
                        } else if header.starts_with("POST /api/auth.Auth/Refresh ") {
                            counts.refresh += 1;
                            (0, tokens(now), false)
                        } else if header.starts_with("POST /api/auth.Auth/GetCurrentUser ") {
                            counts.user += 1;
                            (
                                counts.user_code,
                                serde_json::json!({
                                    "user": {"user_id": "user", "email": "updated@example.test"},
                                    "device": {"device_id": "device"},
                                    "session_id": "session",
                                }),
                                false,
                            )
                        } else if header.starts_with("POST /api/auth.Auth/Logout ") {
                            counts.logout += 1;
                            (0, serde_json::json!({}), false)
                        } else {
                            counts.login += 1;
                            (
                                0,
                                serde_json::json!({"authenticated": {
                                    "user": {"user_id": "user"},
                                    "device": {"device_id": "device"},
                                    "tokens": tokens(now),
                                }}),
                                false,
                            )
                        }
                    };
                    if pause {
                        received.notify_one();
                        let mut probe = [0; 1];
                        tokio::select! {
                            _ = stop.cancelled() => {},
                            _ = socket.read(&mut probe) => {},
                        }
                        disconnected.notify_one();
                        return;
                    }
                    let body = if code == 0 {
                        serde_json::json!({"code":0,"msg":"ok","data":data})
                    } else {
                        serde_json::json!({"code":code,"msg":"fixture rejected"})
                    }
                    .to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        result
    }

    pub fn context(&self, authenticated: bool, expired: bool) -> SessionContext {
        SessionContext {
            server: self.url.clone(),
            connect: false,
            authenticated: authenticated.then(|| {
                pb::Authenticated {
                    user: Some(pb::UserSnapshot {
                        user_id: "user".into(),
                        ..Default::default()
                    }),
                    device: Some(pb::DeviceSnapshot {
                        device_id: "device".into(),
                        ..Default::default()
                    }),
                    tokens: Some(pb::TokenPair {
                        session_id: "session".into(),
                        access_token: "access_0".into(),
                        refresh_token: "refresh_0".into(),
                        access_expires_at_ms: if expired {
                            self.now - 1
                        } else {
                            self.now + 7_200_000
                        },
                        refresh_expires_at_ms: self.now + 86_400_000,
                    }),
                }
                .encode_to_vec()
            }),
        }
    }
}

fn tokens(now: i64) -> serde_json::Value {
    serde_json::json!({
        "session_id": "session", "access_token": "access_1", "refresh_token": "refresh_1",
        "access_expires_at_ms": (now + 7_200_000).to_string(),
        "refresh_expires_at_ms": (now + 86_400_000).to_string(),
    })
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
