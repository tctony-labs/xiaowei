use futures_util::FutureExt;
mod support;

use std::{sync::Arc, time::Duration};

use support::{create, service};
use tokio::time::timeout;
use xw_agent::{AgentError, protocol::*};

#[tokio::test]
async fn close_wakes_waiters_rejects_commands_and_is_repeatable() {
    let service = Arc::new(service());
    let session = create(&service);
    let mut observer = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    observer.recv().await.unwrap().unwrap();
    let waiter = tokio::spawn(async move { while observer.recv().await.is_some() {} });
    tokio::task::yield_now().await;
    service.close().await.unwrap();
    service.close().await.unwrap();
    timeout(Duration::from_secs(1), waiter).await.unwrap().unwrap();
    assert_eq!(
        service
            .read_session(ReadSessionRequest {
                session_id: session.session_id.clone(),
                include_runs: false,
            })
            .now_or_never()
            .expect("memory operation completes immediately"),
        Err(AgentError::Closed)
    );
    assert!(matches!(
        service
            .subscribe_session(SubscribeSessionRequest {
                session_id: session.session_id.clone()
            })
            .now_or_never()
            .expect("memory operation completes immediately"),
        Err(AgentError::Closed)
    ));
}

#[tokio::test]
async fn dropping_service_does_not_leave_observers_waiting_forever() {
    let service = service();
    let session = create(&service);
    let mut observer = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .now_or_never()
        .expect("memory operation completes immediately")
        .unwrap();
    drop(service);
    assert_eq!(timeout(Duration::from_secs(1), observer.recv()).await.unwrap(), None);
}
