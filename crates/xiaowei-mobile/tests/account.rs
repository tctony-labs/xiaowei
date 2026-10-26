mod support;

use prost::Message;
use proto_server_rs::xiaowei::server::auth as pb;
use xiaowei_mobile::{LocalErrorKind, MobileClient, MobileError};

#[tokio::test]
async fn checkpoints_require_acknowledgement_and_cancel_retains_rotation() {
    let server = support::Server::start().await;
    let client = MobileClient::new().unwrap();
    let context = server.context(true, true);
    let operation = client.restore(context.clone(), false).unwrap();
    let checkpoint = operation.run().await.unwrap();
    assert!(checkpoint.checkpoint);
    assert_eq!(checkpoint.code, 0);
    assert_eq!(server.counts.lock().unwrap().refresh, 1);
    assert_eq!(server.counts.lock().unwrap().user, 0);
    assert!(matches!(
        client.maintain(context.clone(), false),
        Err(MobileError::Local {
            kind: LocalErrorKind::Busy,
            ..
        })
    ));
    assert!(matches!(
        operation.resume(checkpoint.credential_version + 1).await,
        Err(MobileError::Local {
            kind: LocalErrorKind::InvalidState,
            ..
        })
    ));

    operation.cancel();
    let cancelled = operation.settled_result().await.unwrap();
    assert_eq!(cancelled.code, 10008);
    assert!(!cancelled.checkpoint);
    assert_eq!(cancelled.credential_version, checkpoint.credential_version);
    assert_eq!(cancelled.authenticated, checkpoint.authenticated);
    let authenticated =
        pb::Authenticated::decode(cancelled.authenticated.unwrap().as_slice()).unwrap();
    assert_eq!(authenticated.tokens.unwrap().refresh_token, "refresh_1");
    operation.close().await.unwrap();
    operation.close().await.unwrap();

    let mut latest = context;
    latest.authenticated = checkpoint.authenticated;
    let operation = client.restore(latest, false).unwrap();
    let result = operation.run().await.unwrap();
    assert_eq!(result.code, 0);
    assert!(!result.checkpoint);
    assert_eq!(server.counts.lock().unwrap().refresh, 1);
    assert_eq!(server.counts.lock().unwrap().user, 1);
    let user = pb::Authenticated::decode(result.authenticated.unwrap().as_slice())
        .unwrap()
        .user
        .unwrap();
    assert_eq!(user.email, "updated@example.test");
    operation.close().await.unwrap();
    client.close().await.unwrap();
}

#[tokio::test]
async fn resume_failure_still_returns_latest_credentials() {
    let server = support::Server::start().await;
    server.counts.lock().unwrap().user_code = 10008;
    let client = MobileClient::new().unwrap();
    let operation = client.restore(server.context(true, true), false).unwrap();
    let checkpoint = operation.run().await.unwrap();
    let failed = operation
        .resume(checkpoint.credential_version)
        .await
        .unwrap();
    assert_eq!(failed.code, 10008);
    assert_eq!(failed.authenticated, checkpoint.authenticated);
    assert!(!failed.checkpoint);
    assert_eq!(server.counts.lock().unwrap().refresh, 1);
    operation.close().await.unwrap();
    client.close().await.unwrap();
}

#[tokio::test]
async fn switching_context_cancels_old_work_without_exposing_the_new_session() {
    let first = support::Server::start().await;
    let second = support::Server::start().await;
    let client = MobileClient::new().unwrap();
    let old = first.context(true, true);
    client.set_session(old.clone()).await.unwrap();
    let operation = client.restore(old.clone(), false).unwrap();
    client
        .set_session(second.context(true, false))
        .await
        .unwrap();
    let result = operation.settled_result().await.unwrap();
    assert_ne!(result.code, 0);
    assert_eq!(result.authenticated, old.authenticated);
    assert_eq!(first.counts.lock().unwrap().refresh, 0);
    assert_eq!(second.counts.lock().unwrap().refresh, 0);
    operation.close().await.unwrap();

    let operation = client.restore(second.context(true, false), false).unwrap();
    assert_eq!(operation.run().await.unwrap().code, 0);
    operation.close().await.unwrap();
    client.suspend().await.unwrap();
    assert!(client.restore(second.context(true, false), false).is_err());
    client
        .set_session(second.context(true, false))
        .await
        .unwrap();
    let operation = client.maintain(second.context(true, false), false).unwrap();
    assert_eq!(operation.run().await.unwrap().code, 0);
    operation.close().await.unwrap();
    client.close().await.unwrap();
}

#[tokio::test]
async fn immediate_cancel_does_not_consume_refresh_or_login() {
    let server = support::Server::start().await;
    let client = MobileClient::new().unwrap();
    let operation = client.restore(server.context(true, true), false).unwrap();
    operation.cancel();
    let result = operation.settled_result().await.unwrap();
    assert_ne!(result.code, 0);
    assert_eq!(operation.run().await.unwrap().code, result.code);
    assert_eq!(server.counts.lock().unwrap().refresh, 0);
    operation.close().await.unwrap();

    let request = pb::LoginRequest {
        device_id: "device".into(),
        credential: Some(pb::login_request::Credential::Password(pb::PasswordLogin {
            email: "fixture@example.test".into(),
            password: " synthetic fixture password ".into(),
        })),
        ..Default::default()
    };
    let operation = client
        .login(server.context(false, false), request.encode_to_vec())
        .unwrap();
    assert_eq!(operation.run().await.unwrap().code, 0);
    assert_eq!(server.counts.lock().unwrap().login, 1);
    operation.close().await.unwrap();
    client.close().await.unwrap();
}

#[tokio::test]
async fn the_first_committed_selection_also_invalidates_an_older_isolated_operation() {
    let first = support::Server::start().await;
    let second = support::Server::start().await;
    let client = MobileClient::new().unwrap();
    let context = first.context(true, true);
    let operation = client.restore(context.clone(), false).unwrap();
    client
        .set_session(second.context(true, false))
        .await
        .unwrap();
    let result = operation.settled_result().await.unwrap();
    assert_ne!(result.code, 0);
    assert_eq!(result.authenticated, context.authenticated);
    assert_eq!(first.counts.lock().unwrap().refresh, 0);
    operation.close().await.unwrap();
    client.close().await.unwrap();
}

#[tokio::test]
async fn accepting_rotated_credentials_does_not_reset_the_pending_checkpoint() {
    for preconfigured in [false, true] {
        let server = support::Server::start().await;
        let client = MobileClient::new().unwrap();
        let mut context = server.context(true, true);
        if preconfigured {
            client.set_session(context.clone()).await.unwrap();
        }
        let operation = client.restore(context.clone(), false).unwrap();
        let checkpoint = operation.run().await.unwrap();
        assert!(checkpoint.checkpoint);
        assert_eq!(server.counts.lock().unwrap().user, 0);

        context.authenticated = checkpoint.authenticated;
        client.set_session(context).await.unwrap();
        let result = operation
            .resume(checkpoint.credential_version)
            .await
            .unwrap();
        assert_eq!(result.code, 0);
        assert!(!result.checkpoint);
        assert_eq!(result.credential_version, checkpoint.credential_version);
        assert_eq!(server.counts.lock().unwrap().refresh, 1);
        assert_eq!(server.counts.lock().unwrap().user, 1);
        operation.close().await.unwrap();
        client.close().await.unwrap();
    }
}

#[tokio::test]
async fn suspending_a_checkpoint_preserves_credentials_for_the_host_to_save() {
    let server = support::Server::start().await;
    let client = MobileClient::new().unwrap();
    let mut context = server.context(true, true);
    let operation = client.restore(context.clone(), false).unwrap();
    let checkpoint = operation.run().await.unwrap();
    client.suspend().await.unwrap();
    let retained = operation.settled_result().await.unwrap();
    assert_ne!(retained.code, 0);
    assert!(!retained.checkpoint);
    assert_eq!(retained.authenticated, checkpoint.authenticated);

    context.authenticated = retained.authenticated;
    client.set_session(context.clone()).await.unwrap();
    let next = client.maintain(context, false).unwrap();
    assert_eq!(next.run().await.unwrap().code, 0);
    assert_eq!(server.counts.lock().unwrap().refresh, 1);
    assert_eq!(server.counts.lock().unwrap().user, 0);
    next.close().await.unwrap();
    client.close().await.unwrap();
}
