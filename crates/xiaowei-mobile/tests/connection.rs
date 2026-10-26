use xiaowei_mobile::{LocalErrorKind, MobileClient, MobileError, Status};

#[tokio::test]
async fn subscriptions_have_one_waiter_and_close_without_an_extra_event() {
    let client = MobileClient::new().unwrap();
    let subscription = client.subscribe_connection().unwrap();
    assert_eq!(
        subscription.next().await.unwrap().unwrap().status,
        Status::Disconnected
    );
    let waiting = subscription.next();
    tokio::pin!(waiting);
    assert!(futures_util::poll!(waiting.as_mut()).is_pending());
    assert!(matches!(
        subscription.next().await,
        Err(MobileError::Local {
            kind: LocalErrorKind::Busy,
            ..
        })
    ));
    subscription.close();
    assert!(waiting.await.unwrap().is_none());
    assert!(subscription.next().await.unwrap().is_none());

    let subscription = client.subscribe_connection().unwrap();
    subscription.next().await.unwrap();
    let waiting = subscription.next();
    tokio::pin!(waiting);
    assert!(futures_util::poll!(waiting.as_mut()).is_pending());
    client.close().await.unwrap();
    assert!(waiting.await.unwrap().is_none());
    assert!(client.subscribe_connection().is_err());
}
