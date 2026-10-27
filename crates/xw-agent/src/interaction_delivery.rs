use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use tokio::sync::Notify;
use xw_agent_types::SessionId;

use crate::{AgentError, AgentService, protocol::*, service::State, session::parse_id};

const MAX_OBSERVERS: usize = 64;
const MAX_DELIVERIES: usize = 64;

struct Receipt {
    interaction_id: String,
    acknowledged: bool,
}

pub(crate) struct DeliveryObserver {
    session_id: SessionId,
    caller: String,
    id: String,
    closed: AtomicBool,
    receipts: Mutex<BTreeMap<String, Receipt>>,
    pub wake: Notify,
}

impl DeliveryObserver {
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        log::debug!(
            "Agent interaction observer closed session={} observer={}",
            self.session_id,
            self.id
        );
        self.wake.notify_one();
    }
}

/// Per-caller pull delivery. Dropping this stream never resolves an interaction.
pub struct InteractionSubscription {
    state: Arc<Mutex<State>>,
    observer: Arc<DeliveryObserver>,
    ready: bool,
}

impl InteractionSubscription {
    pub async fn recv(&mut self) -> Option<InteractionDeliveryEvent> {
        loop {
            let notified = self.observer.wake.notified();
            {
                let state = self.state.lock().ok()?;
                let session = state.sessions.get(&self.observer.session_id)?;
                if state.closed
                    || session.deleted()
                    || session.view.archived
                    || self.observer.closed.load(Ordering::Acquire)
                {
                    return None;
                }
                if !self.ready {
                    self.ready = true;
                    return Some(InteractionDeliveryEvent {
                        payload: Some(interaction_delivery_event::Payload::Ready(
                            InteractionObserverReady {
                                instance_id: state.interaction_instance.clone(),
                                observer_id: self.observer.id.clone(),
                            },
                        )),
                    });
                }
                let mut receipts = self.observer.receipts.lock().unwrap();
                for record in session
                    .interactions
                    .values()
                    .filter(|record| record.pending())
                {
                    let interaction_id = record.opened.interaction_id.to_string();
                    if receipts
                        .values()
                        .any(|r| r.interaction_id == interaction_id)
                    {
                        continue;
                    }
                    if receipts.len() >= MAX_DELIVERIES {
                        receipts.pop_first();
                    }
                    let delivery_id = uuid::Uuid::now_v7().to_string();
                    receipts.insert(
                        delivery_id.clone(),
                        Receipt {
                            interaction_id,
                            acknowledged: false,
                        },
                    );
                    return Some(InteractionDeliveryEvent {
                        payload: Some(interaction_delivery_event::Payload::Delivery(
                            InteractionDelivery {
                                delivery_id,
                                interaction: Some(record.view()),
                            },
                        )),
                    });
                }
            }
            if tokio::time::timeout(Duration::from_secs(20), notified)
                .await
                .is_err()
            {
                return Some(InteractionDeliveryEvent {
                    payload: Some(interaction_delivery_event::Payload::Heartbeat(
                        InteractionHeartbeat {},
                    )),
                });
            }
        }
    }

    pub fn close(&self) {
        self.observer.close();
    }
}

impl Drop for InteractionSubscription {
    fn drop(&mut self) {
        self.close();
    }
}

impl AgentService {
    pub async fn observe_interactions(
        &self,
        request: ObserveInteractionsRequest,
        caller: String,
    ) -> Result<InteractionSubscription, AgentError> {
        let session_id = parse_id(&request.session_id, "session_id")?;
        if caller.trim().is_empty() || caller.len() > 1024 {
            return Err(AgentError::InvalidArgument("caller"));
        }
        self.read_session(ReadSessionRequest {
            session_id: request.session_id,
            include_runs: false,
        })
        .await?;
        let mut state = self.state()?;
        state
            .sessions
            .get(&session_id)
            .filter(|s| !s.deleted())
            .ok_or(AgentError::NotFound("session"))?
            .available()?;
        let active = state
            .interaction_observers
            .iter()
            .filter(|o| !o.closed.load(Ordering::Acquire))
            .count();
        if active >= MAX_OBSERVERS {
            return Err(AgentError::ResourceExhausted("interaction observers"));
        }
        // Keep at most 64 retired observers for bounded, idempotent late receipts.
        let mut retired = 0;
        state.interaction_observers.reverse();
        state.interaction_observers.retain(|observer| {
            if !observer.closed.load(Ordering::Acquire) {
                return true;
            }
            retired += 1;
            retired <= MAX_OBSERVERS
        });
        state.interaction_observers.reverse();
        let observer = Arc::new(DeliveryObserver {
            session_id,
            caller,
            id: uuid::Uuid::now_v7().to_string(),
            closed: AtomicBool::new(false),
            receipts: Mutex::new(BTreeMap::new()),
            wake: Notify::new(),
        });
        state.interaction_observers.push(observer.clone());
        log::debug!(
            "Agent interaction observer opened session={session_id} observer={}",
            observer.id
        );
        Ok(InteractionSubscription {
            state: self.state.clone(),
            observer,
            ready: false,
        })
    }

    pub fn acknowledge_interaction(
        &self,
        request: AcknowledgeInteractionRequest,
        caller: &str,
    ) -> Result<AcknowledgeInteractionResponse, AgentError> {
        let state = self.state()?;
        if request.instance_id != state.interaction_instance {
            return Err(AgentError::Conflict("interaction service instance expired"));
        }
        let observer = state
            .interaction_observers
            .iter()
            .find(|o| o.id == request.observer_id && o.caller == caller)
            .ok_or(AgentError::Conflict(
                "interaction observer expired or caller mismatch",
            ))?;
        let mut receipts = observer.receipts.lock().unwrap();
        let receipt = receipts
            .get_mut(&request.delivery_id)
            .filter(|r| r.interaction_id == request.interaction_id)
            .ok_or(AgentError::Conflict(
                "interaction delivery expired or mismatched",
            ))?;
        if !receipt.acknowledged {
            receipt.acknowledged = true;
            log::debug!(
                "Agent interaction received observer={} interaction={} delivery={}",
                observer.id,
                receipt.interaction_id,
                request.delivery_id
            );
        }
        Ok(AcknowledgeInteractionResponse {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn idle_delivery_sends_heartbeats_and_close_wakes_a_pending_pull() {
        let state = Arc::new(Mutex::new(State {
            tools: Vec::new(),
            closed: false,
            sessions: Default::default(),
            creations: Default::default(),
            observers: vec![],
            viewers: Default::default(),
            interaction_instance: "instance".into(),
            interaction_observers: vec![],
        }));
        let session_id = SessionId::new();
        state.lock().unwrap().sessions.insert(
            session_id,
            crate::session::Session::new(
                session_id,
                1,
                AgentModelConfig {
                    model_ref: "fixture".into(),
                    reasoning: None,
                },
            ),
        );
        let observer = Arc::new(DeliveryObserver {
            session_id,
            caller: "caller".into(),
            id: "observer".into(),
            closed: AtomicBool::new(false),
            receipts: Mutex::new(BTreeMap::new()),
            wake: Notify::new(),
        });
        let mut stream = InteractionSubscription {
            state,
            observer: observer.clone(),
            ready: false,
        };
        assert!(matches!(
            stream.recv().await.unwrap().payload,
            Some(interaction_delivery_event::Payload::Ready(_))
        ));
        let started = tokio::time::Instant::now();
        assert!(matches!(
            stream.recv().await.unwrap().payload,
            Some(interaction_delivery_event::Payload::Heartbeat(_))
        ));
        assert_eq!(started.elapsed(), Duration::from_secs(20));
        let pull = tokio::spawn(async move { stream.recv().await });
        tokio::task::yield_now().await;
        observer.close();
        assert!(pull.await.unwrap().is_none());
    }
}
