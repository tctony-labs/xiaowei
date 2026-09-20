//! JSON framing exists only in this fake transport test process, never in product Gateway.
use std::io::{self, BufRead, Write};
use xw_contracts::testing::Envelope;
use xw_gateway::{protocol::Route, *};
#[path = "../tests/fixture_bindings.rs"]
mod fixture_bindings;
use fixture_bindings::testing_fixture_service::{ECHO, WATCH};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let registry = XwInvokeRegistry::new();
    if std::env::args().any(|arg| arg == "--client") {
        registry.set_remote_invoker(|route, payload, _| async move {
            println!("{}", serde_json::json!({ "route": route, "payload": payload }));
            io::stdout().flush().unwrap();
            let mut response = String::new();
            io::stdin().read_line(&mut response).unwrap();
            let response: serde_json::Value = serde_json::from_str(&response).unwrap();
            if response["ok"] == true {
                Ok(serde_json::from_value(response["value"].clone()).unwrap())
            } else {
                Err(serde_json::from_value(response["error"].clone()).unwrap())
            }
        });
        let request = Envelope {
            text: "Rust → TS 🦀".into(),
            id: u64::MAX,
            label: Some(String::new()),
            ..Default::default()
        };
        assert_eq!(
            ECHO.call(&registry.client(CallContext::trusted("rust")), request.clone())
                .await
                .unwrap(),
            request
        );
        return;
    }
    registry
        .register_owner(
            "fixture",
            vec![
                ECHO.handler(|request, _| async {
                    if request.text == "fail" {
                        return Err(GatewayError::new(ErrorCode::HandlerError, "fixture failed"));
                    }
                    Ok(request)
                }),
                InvokeRegistration::stream(WATCH.route()),
            ],
            vec![],
        )
        .unwrap();
    for line in io::stdin().lock().lines() {
        let frame: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        let route: Route = serde_json::from_value(frame["route"].clone()).unwrap();
        let payload: Vec<u8> = serde_json::from_value(frame["payload"].clone()).unwrap();
        let response = match registry.call(&route, payload, CallContext::trusted("ts")).await {
            Ok(value) => serde_json::json!({ "ok": true, "value": value }),
            Err(error) => serde_json::json!({ "ok": false, "error": error }),
        };
        println!("{response}");
        io::stdout().flush().unwrap();
    }
}
