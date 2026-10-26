use proto_server_rs::xiaowei::server::auth as pb;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
};

pub struct State {
    pub refreshes: usize,
    pub users: usize,
    pub logouts: usize,
    pub token: usize,
    pub current_code: i32,
    pub mismatched_user: bool,
    pub pause_refresh: bool,
}

pub struct Server {
    pub url: String,
    pub state: Arc<Mutex<State>>,
    pub started: Arc<Notify>,
    pub release: Arc<Notify>,
    stop: tokio_util::sync::CancellationToken,
    pub now: i64,
}

impl Server {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State {
            refreshes: 0,
            users: 0,
            logouts: 0,
            token: 0,
            current_code: 0,
            mismatched_user: false,
            pause_refresh: false,
        }));
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let stop = tokio_util::sync::CancellationToken::new();
        let server = Self {
            url,
            state: state.clone(),
            started: started.clone(),
            release: release.clone(),
            stop: stop.clone(),
            now: xw_api::now_ms(),
        };
        let now = server.now;
        tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = stop.cancelled() => return,
                    accepted = listener.accept() => accepted,
                };
                let (mut socket, _) = accepted.unwrap();
                let state = state.clone();
                let started = started.clone();
                let release = release.clone();
                tokio::spawn(async move {
                    let mut bytes = Vec::new();
                    loop {
                        let mut buffer = [0u8; 8192];
                        let count = socket.read(&mut buffer).await.unwrap_or(0);
                        if count == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buffer[..count]);
                        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                            let header = String::from_utf8_lossy(&bytes[..end]);
                            let length = header
                                .lines()
                                .find_map(|line| {
                                    line.to_lowercase()
                                        .strip_prefix("content-length: ")
                                        .and_then(|v| v.parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if bytes.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    let text = String::from_utf8_lossy(&bytes);
                    let refresh = text.starts_with("POST /api/auth.Auth/Refresh ");
                    let pause = { state.lock().unwrap().pause_refresh && refresh };
                    if pause {
                        started.notify_one();
                        release.notified().await;
                    }
                    let (code, data) = {
                        let mut state = state.lock().unwrap();
                        if refresh {
                            state.refreshes += 1;
                            state.token += 1;
                            (0, tokens(state.token, "session", now))
                        } else if text.starts_with("POST /api/auth.Auth/GetCurrentUser ") {
                            state.users += 1;
                            let user = if state.mismatched_user {
                                "wrong"
                            } else {
                                "user"
                            };
                            (
                                state.current_code,
                                serde_json::json!({
                                    "user": {"user_id": user},
                                    "device": {"device_id": "device"},
                                    "session_id": "session",
                                }),
                            )
                        } else if text.starts_with("POST /api/auth.Auth/Logout ") {
                            state.logouts += 1;
                            (0, serde_json::json!({}))
                        } else {
                            (
                                0,
                                serde_json::json!({"authenticated": {
                                    "user":{"user_id":"user"}, "device":{"device_id":"device"},
                                    "tokens": tokens(0, "session", now),
                                }}),
                            )
                        }
                    };
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
        server
    }

    pub fn session(&self, expiry: i64) -> xw_api::account::Session {
        xw_api::account::Session {
            server: self.url.clone(),
            authenticated: pb::Authenticated {
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
                    access_expires_at_ms: expiry,
                    refresh_expires_at_ms: self.now + 30 * 86_400_000,
                }),
            },
        }
    }
}

fn tokens(index: usize, session: &str, now: i64) -> serde_json::Value {
    serde_json::json!({
        "session_id": session,
        "access_token": format!("access_{index}"),
        "refresh_token": format!("refresh_{index}"),
        "access_expires_at_ms": (now + 7_200_000).to_string(),
        "refresh_expires_at_ms": (now + 30 * 86_400_000).to_string(),
    })
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.cancel();
        self.release.notify_waiters();
    }
}
