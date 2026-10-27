use super::support;
use proto_server_rs::xiaowei::server as pb;
use tokio_util::sync::CancellationToken;
use xw_api::account::{Access, Operation, SessionCore};

#[tokio::test]
async fn login_identity_logout_and_host_permissions_use_the_concrete_api() {
    let server = support::Server::start().await;
    let api = xw_api::Client::new().unwrap();
    let core = SessionCore::new(api.clone());
    core.activate(server.url.clone(), None, false, server.now);
    let request = pb::LoginRequest {
        device_id: "device".into(),
        credential: Some(pb::login_request::Credential::Password(pb::PasswordLogin {
            email: "user@example.test".into(),
            password: "sample".into(),
        })),
        ..Default::default()
    };
    let result = core
        .start(
            "login".into(),
            Operation::Login(request),
            server.now,
            Access::default(),
            CancellationToken::new(),
        )
        .await;
    assert_eq!(result.code, 0);
    assert_eq!(
        result.session.unwrap().authenticated.user.unwrap().user_id,
        "user"
    );
    server.state.lock().unwrap().mismatched_user = true;
    let result = core
        .start(
            "restore".into(),
            Operation::Restore { force: false },
            server.now,
            Access::default(),
            CancellationToken::new(),
        )
        .await;
    assert_eq!(result.code, 10008);
    assert_eq!(
        result.session.unwrap().authenticated.user.unwrap().user_id,
        "user"
    );
    let result = core
        .start(
            "denied".into(),
            Operation::Logout,
            server.now,
            Access {
                logout: false,
                ..Default::default()
            },
            CancellationToken::new(),
        )
        .await;
    assert_eq!(result.code, 10003);
    assert_eq!(server.state.lock().unwrap().logouts, 0);
    let result = core
        .start(
            "logout".into(),
            Operation::Logout,
            server.now,
            Access::default(),
            CancellationToken::new(),
        )
        .await;
    assert_eq!(result.code, 0);
    assert_eq!(server.state.lock().unwrap().logouts, 1);
    core.close().await;
    core.close().await;
    api.close().await;
}

#[tokio::test]
async fn suspend_rejects_old_work_and_resuming_imports_only_host_selected_session() {
    let server = support::Server::start().await;
    let api = xw_api::Client::new().unwrap();
    let core = SessionCore::new(api.clone());
    core.activate(
        server.url.clone(),
        Some(server.session(server.now + 7_200_000)),
        false,
        server.now,
    );
    core.suspend();
    let result = core
        .start(
            "suspended".into(),
            Operation::Restore { force: false },
            server.now,
            Access::default(),
            CancellationToken::new(),
        )
        .await;
    assert_eq!(result.code, 10008);
    assert_eq!(server.state.lock().unwrap().users, 0);
    core.activate(
        server.url.clone(),
        Some(server.session(server.now + 7_200_000)),
        false,
        server.now,
    );
    assert_eq!(
        core.start(
            "resumed".into(),
            Operation::Restore { force: false },
            server.now,
            Access::default(),
            CancellationToken::new()
        )
        .await
        .code,
        0
    );
    assert_eq!(server.state.lock().unwrap().users, 1);
    api.close().await;
}

#[tokio::test]
async fn target_replacement_cancels_inflight_work_without_exposing_new_credentials() {
    let server = support::Server::start().await;
    let api = xw_api::Client::new().unwrap();
    let core = SessionCore::new(api.clone());
    core.activate(
        server.url.clone(),
        Some(server.session(server.now)),
        false,
        server.now,
    );
    server.state.lock().unwrap().pause_refresh = true;
    let work = core.start(
        "old".into(),
        Operation::Maintain { force: true },
        server.now,
        Access::default(),
        CancellationToken::new(),
    );
    let replace = async {
        server.started.notified().await;
        let mut replacement = server.session(server.now + 7_200_000);
        replacement.authenticated.user.as_mut().unwrap().user_id = "replacement".into();
        core.activate(server.url.clone(), Some(replacement), false, server.now);
        server.release.notify_one();
    };
    let (result, _) = tokio::join!(work, replace);
    assert_eq!(result.code, 10008);
    assert!(
        result
            .session
            .is_none_or(|session| session.authenticated.user.unwrap().user_id != "replacement")
    );
    assert_eq!(
        core.outcome(server.now)
            .session
            .unwrap()
            .authenticated
            .user
            .unwrap()
            .user_id,
        "replacement"
    );
    core.close().await;
    api.close().await;
}
