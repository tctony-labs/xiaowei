use prost::Message;
use proto_server_rs::xiaowei::server::auth as pb;
use proto_server_rs::xiaowei::server::common::{BaseResponse, ErrorCode};

fn authenticated(now: i64, index: u8, expired: bool, updated: bool) -> pb::Authenticated {
    pb::Authenticated {
        user: Some(pb::UserSnapshot {
            user_id: "fixture-user".into(),
            email: if updated {
                "updated@example.test"
            } else {
                "before@example.test"
            }
            .into(),
            created_at_ms: 42,
        }),
        device: Some(pb::DeviceSnapshot {
            device_id: "00000000-0000-4000-8000-000000000001".into(),
            device_name: "fixture-device".into(),
        }),
        tokens: Some(pb::TokenPair {
            session_id: "fixture-session".into(),
            access_token: format!("access_{index}"),
            refresh_token: format!("refresh_{index}"),
            access_expires_at_ms: if expired { now - 1 } else { now + 7_200_000 },
            refresh_expires_at_ms: now + 86_400_000,
        }),
    }
}

fn main() {
    let now: i64 = std::env::args()
        .nth(1)
        .expect("fixture time")
        .parse()
        .unwrap();
    let login = pb::LoginRequest {
        device_id: "00000000-0000-4000-8000-000000000001".into(),
        device_name: "fixture-device".into(),
        credential: Some(pb::login_request::Credential::Password(pb::PasswordLogin {
            email: "fixture@example.test".into(),
            password: " synthetic fixture password ".into(),
        })),
        ..Default::default()
    };
    println!(
        "{}",
        serde_json::json!({
            "valid": authenticated(now, 0, false, false).encode_to_vec(),
            "expired": authenticated(now, 0, true, false).encode_to_vec(),
            "rotated": authenticated(now, 1, false, false).encode_to_vec(),
            "updated": authenticated(now, 1, false, true).encode_to_vec(),
            "updated2": authenticated(now, 2, false, true).encode_to_vec(),
            "login": login.encode_to_vec(),
            "health": BaseResponse { code: 0, msg: "ok".into(), data: Some(()) }.encode_to_vec(),
            "business": BaseResponse {
                code: ErrorCode::InvalidArgument as i32,
                msg: "fixture rejected".into(),
                data: None,
            }.encode_to_vec(),
            "business_code": ErrorCode::InvalidArgument as i32,
        })
    );
}
