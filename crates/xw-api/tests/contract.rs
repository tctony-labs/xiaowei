use prost::Message;
use proto_server_rs::xiaowei::server::auth as pb;
use xw_api::{contract::Method, normalize_server};

#[test]
fn descriptors_preserve_default_authentication_and_standard_proto_json() {
    for name in ["Login", "Refresh"] {
        let method = Method::resolve(&format!("xiaowei.server.auth.Auth.{name}")).unwrap();
        assert!(!method.requires_login);
        assert_eq!(method.id, format!("auth.Auth/{name}"));
        assert_eq!(method.path, format!("/api/auth.Auth/{name}"));
    }
    for name in ["GetCurrentUser", "Logout"] {
        assert!(
            Method::resolve(&format!("xiaowei.server.auth.Auth.{name}"))
                .unwrap()
                .requires_login
        );
    }
    let method = Method::resolve("xiaowei.server.auth.Auth.Login").unwrap();
    let request = pb::LoginRequest {
        device_id: "device".into(),
        credential: Some(pb::login_request::Credential::Password(pb::PasswordLogin {
            email: "user@example.test".into(),
            password: "  sample  ".into(),
        })),
        thirdparty_bind_token: Some("proof".into()),
        ..Default::default()
    };
    let json: serde_json::Value =
        serde_json::from_str(&method.encode_json(&request.encode_to_vec()).unwrap()).unwrap();
    assert_eq!(json["password"]["password"], "  sample  ");
    assert_eq!(json["device_id"], "device");
    assert_eq!(json["thirdparty_bind_token"], "proof");
    let json = concat!(
        r#"{"code":0,"msg":"ok","data":{"binding_required":{"#,
        r#""thirdparty_bind_token":"next","expires_at_ms":"9007199254740993"}}}"#,
    );
    let bytes = method.decode_json(json.as_bytes()).unwrap();
    let data = pb::LoginResponse::decode(bytes.as_slice())
        .unwrap()
        .data
        .unwrap();
    let Some(pb::login_result::Result::BindingRequired(binding)) = data.result else {
        panic!()
    };
    assert_eq!(binding.expires_at_ms, 9_007_199_254_740_993);
}

#[test]
fn json_envelope_rejects_malformed_success_and_preserves_business_failures() {
    let method = Method::resolve("xiaowei.server.common.Health.Check").unwrap();
    assert!(!method.requires_login);
    for value in [
        "null",
        "invalid",
        r#"{"msg":"ok","data":{}}"#,
        r#"{"code":0,"data":{}}"#,
        r#"{"code":0,"msg":"ok"}"#,
        r#"{"code":0,"msg":"ok","data":null}"#,
        r#"{"code":0,"msg":"ok","data":{"unknown":true}}"#,
        r#"{"code":2147483648,"msg":"bad"}"#,
    ] {
        assert!(method.decode_json(value.as_bytes()).is_err(), "{value}");
    }
    let error = method
        .decode_json(br#"{"code":10999,"msg":"denied"}"#)
        .unwrap_err();
    assert_eq!(error.code, 10999);
    assert_eq!(error.message, "denied");
    assert!(
        method
            .decode_json(br#"{"code":0,"msg":"ok","data":{}}"#)
            .is_ok()
    );
}

#[test]
fn addresses_match_desktop_normalization() {
    for (input, expected) in [
        (" HTTPS://Example.COM:443/// ", "https://example.com"),
        ("http://localhost:80/path/", "http://localhost/path"),
        (
            "http://127.0.0.1:123/xiaowei/",
            "http://127.0.0.1:123/xiaowei",
        ),
        ("http://[::1]:8080/", "http://[::1]:8080"),
        ("https://example.com/a%20b/", "https://example.com/a%20b"),
    ] {
        assert_eq!(normalize_server(input).unwrap(), expected);
    }
    for input in [
        "",
        "https://user:secret@example.com",
        "https://example.com?token=1",
        "https://example.com/#fragment",
        "http://remote.example",
        "file:///tmp",
        "ws://localhost",
    ] {
        assert!(normalize_server(input).is_err());
    }
}
