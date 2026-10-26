use super::support;
use tokio_util::sync::CancellationToken;
use xw_api::account::{Access, Operation, SessionCore};

#[tokio::test]
async fn concurrent_forced_refresh_consumes_one_token_and_obeys_five_minute_lead() {
    let server = support::Server::start().await;
    let api = xw_api::Client::new().unwrap();
    let core = SessionCore::new(api.clone());
    core.activate(
        server.url.clone(),
        Some(server.session(server.now + 300_001)),
        false,
        server.now,
    );
    assert_eq!(
        core.start(
            "initial".into(),
            Operation::Maintain { force: false },
            server.now,
            Access::default(),
            CancellationToken::new()
        )
        .await
        .code,
        0
    );
    assert_eq!(server.state.lock().unwrap().refreshes, 0);
    core.start(
        "due".into(),
        Operation::Maintain { force: false },
        server.now + 1,
        Access::default(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(server.state.lock().unwrap().refreshes, 1);
    server.state.lock().unwrap().pause_refresh = true;
    let first = core.start(
        "first".into(),
        Operation::Maintain { force: true },
        server.now,
        Access::default(),
        CancellationToken::new(),
    );
    let second = async {
        server.started.notified().await;
        let pending = core.start(
            "second".into(),
            Operation::Maintain { force: true },
            server.now,
            Access::default(),
            CancellationToken::new(),
        );
        let release = async {
            tokio::task::yield_now().await;
            server.release.notify_one();
        };
        let (result, _) = tokio::join!(pending, release);
        result
    };
    let (first, second) = tokio::join!(first, second);
    assert_eq!((first.code, second.code), (0, 0));
    assert_eq!(server.state.lock().unwrap().refreshes, 2);
    assert_eq!(first.credential_version, second.credential_version);
    core.close().await;
    api.close().await;
}

#[tokio::test]
async fn restore_stops_at_rotation_and_retains_pair_after_cancel_or_later_failure() {
    let server = support::Server::start().await;
    let api = xw_api::Client::new().unwrap();
    let core = SessionCore::new(api.clone());
    core.activate(
        server.url.clone(),
        Some(server.session(server.now)),
        false,
        server.now,
    );
    let result = core
        .start(
            "restore".into(),
            Operation::Restore { force: false },
            server.now,
            Access::default(),
            CancellationToken::new(),
        )
        .await;
    assert_eq!(result.code, 0);
    assert!(result.checkpoint);
    assert_eq!(
        server.state.lock().unwrap().users,
        0,
        "host accepts rotation before validation"
    );
    assert_eq!(
        result
            .session
            .unwrap()
            .authenticated
            .tokens
            .unwrap()
            .refresh_token,
        "refresh_1"
    );
    server.state.lock().unwrap().current_code = 10008;
    let failed = core
        .resume("restore", server.now, CancellationToken::new())
        .await;
    assert_eq!(failed.code, 10008);
    assert_eq!(
        failed
            .session
            .unwrap()
            .authenticated
            .tokens
            .unwrap()
            .refresh_token,
        "refresh_1"
    );
    let result = core
        .start(
            "again".into(),
            Operation::Restore { force: true },
            server.now,
            Access::default(),
            CancellationToken::new(),
        )
        .await;
    assert!(result.checkpoint);
    core.cancel("again");
    let result = core
        .resume("again", server.now, CancellationToken::new())
        .await;
    assert_eq!(result.code, 10008);
    assert_eq!(
        result
            .session
            .unwrap()
            .authenticated
            .tokens
            .unwrap()
            .refresh_token,
        "refresh_2"
    );
    assert_eq!(
        core.outcome(server.now).credential_version,
        failed.credential_version + 1
    );
    core.close().await;
    api.close().await;
}

#[tokio::test]
async fn cancelled_checkpoint_settles_with_rotated_credentials_and_allows_the_next_operation() {
    for operation in [Operation::Restore { force: false }, Operation::Logout] {
        let server = support::Server::start().await;
        let api = xw_api::Client::new().unwrap();
        let core = SessionCore::new(api.clone());
        core.activate(
            server.url.clone(),
            Some(server.session(server.now)),
            false,
            server.now,
        );
        let checkpoint = core
            .start(
                "cancelled".into(),
                operation,
                server.now,
                Access::default(),
                CancellationToken::new(),
            )
            .await;
        assert!(checkpoint.checkpoint);

        core.cancel("cancelled");
        let cancelled = core.settled_outcome(server.now).await;
        assert_eq!(cancelled.code, 10008);
        assert!(!cancelled.checkpoint);
        assert_eq!(cancelled.credential_version, checkpoint.credential_version);
        assert_eq!(
            cancelled
                .session
                .unwrap()
                .authenticated
                .tokens
                .unwrap()
                .refresh_token,
            "refresh_1"
        );

        let next = core
            .start(
                "next".into(),
                Operation::Maintain { force: false },
                server.now,
                Access::default(),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(next.code, 0);
        assert!(!next.checkpoint);
        assert_eq!(next.credential_version, checkpoint.credential_version);
        assert_eq!(server.state.lock().unwrap().refreshes, 1);
        assert_eq!(server.state.lock().unwrap().users, 0);
        assert_eq!(server.state.lock().unwrap().logouts, 0);
        core.close().await;
        api.close().await;
    }
}

#[tokio::test]
async fn unauthenticated_http_validation_refreshes_only_once_and_expiry_needs_no_network() {
    let server = support::Server::start().await;
    let api = xw_api::Client::new().unwrap();
    let core = SessionCore::new(api.clone());
    core.activate(
        server.url.clone(),
        Some(server.session(server.now + 7_200_000)),
        false,
        server.now,
    );
    server.state.lock().unwrap().current_code = 10002;
    let result = core
        .start(
            "restore".into(),
            Operation::Restore { force: false },
            server.now,
            Access::default(),
            CancellationToken::new(),
        )
        .await;
    assert!(result.checkpoint);
    let result = core
        .resume("restore", server.now, CancellationToken::new())
        .await;
    assert_eq!(result.code, 10002);
    assert_eq!(server.state.lock().unwrap().refreshes, 1);
    assert_eq!(server.state.lock().unwrap().users, 2);
    let mut expired = server.session(server.now);
    expired
        .authenticated
        .tokens
        .as_mut()
        .unwrap()
        .refresh_expires_at_ms = server.now;
    core.activate(server.url.clone(), Some(expired), false, server.now);
    assert_eq!(
        core.start(
            "expired".into(),
            Operation::Restore { force: false },
            server.now,
            Access::default(),
            CancellationToken::new()
        )
        .await
        .code,
        10002
    );
    assert_eq!(server.state.lock().unwrap().users, 2);
    api.close().await;
}
