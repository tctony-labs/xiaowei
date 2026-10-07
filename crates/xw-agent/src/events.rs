use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use prost::Message;
use tokio::sync::Notify;

use crate::{
    AgentError,
    protocol::{AgentEvent, agent_event},
};

const MAX_PENDING: usize = 64;
const MAX_PENDING_BYTES: usize = 1024 * 1024;

#[derive(Default)]
struct Pending {
    closed: bool,
    lagged: bool,
    events: VecDeque<AgentEvent>,
    bytes: usize,
}

pub(crate) struct Observer {
    session_id: String,
    pending: Mutex<Pending>,
    wake: Notify,
}

impl Observer {
    pub fn new(session_id: String) -> Self {
        Self {
            session_id,
            pending: Mutex::new(Pending::default()),
            wake: Notify::new(),
        }
    }

    // Called under the service state lock before observer registration. Fail
    // explicitly if the complete snapshot cannot fit; no observer is retained.
    pub fn initialize(&self, event: AgentEvent) -> Result<(), AgentError> {
        if event.encoded_len() > MAX_PENDING_BYTES {
            return Err(AgentError::ResourceExhausted("subscription snapshot"));
        }
        self.publish(event);
        Ok(())
    }

    pub fn publish(&self, event: AgentEvent) {
        let event_session = match &event.payload {
            Some(agent_event::Payload::SessionStarted(event)) => {
                event.session.as_ref().map(|session| session.session_id.as_str())
            }
            Some(agent_event::Payload::SessionArchivedUpdated(event)) => Some(event.session_id.as_str()),
            Some(agent_event::Payload::SessionDeleted(event)) => Some(event.session_id.as_str()),
            Some(agent_event::Payload::SessionConfigUpdated(event)) => Some(event.session_id.as_str()),
            Some(agent_event::Payload::SessionModelInfoWarningUpdated(event)) => Some(event.session_id.as_str()),
            Some(agent_event::Payload::SessionTitleUpdated(event)) => Some(event.session_id.as_str()),
            Some(agent_event::Payload::RunStarted(event)) => Some(event.session_id.as_str()),
            Some(agent_event::Payload::RunCompleted(event)) => Some(event.session_id.as_str()),
            Some(agent_event::Payload::ItemStarted(event)) => Some(event.session_id.as_str()),
            Some(agent_event::Payload::ItemCompleted(event)) => Some(event.session_id.as_str()),
            Some(agent_event::Payload::AgentMessageDelta(event)) => Some(event.session_id.as_str()),
            Some(agent_event::Payload::ReasoningDelta(event)) => Some(event.session_id.as_str()),
            Some(agent_event::Payload::SubscriptionReady(event)) => {
                event.session.as_ref().map(|session| session.session_id.as_str())
            }
            None => None,
        };
        if event_session != Some(self.session_id.as_str()) {
            return;
        }
        let mut pending = self.pending.lock().unwrap();
        if pending.closed {
            return;
        }
        let bytes = event.encoded_len();
        if pending.events.len() >= MAX_PENDING || pending.bytes + bytes > MAX_PENDING_BYTES {
            pending.events.clear();
            pending.bytes = 0;
            pending.lagged = true;
            pending.closed = true;
            log::warn!("Agent event subscriber lagged; resubscribe for a fresh snapshot");
        } else {
            pending.bytes += bytes;
            pending.events.push_back(event);
        }
        drop(pending);
        self.wake.notify_one();
    }

    pub fn is_closed(&self) -> bool {
        self.pending.lock().unwrap().closed
    }

    pub fn finish_session(&self, id: &str) {
        if self.session_id != id {
            return;
        }
        self.pending.lock().unwrap().closed = true;
        self.wake.notify_one();
    }

    pub fn close(&self) {
        let mut pending = self.pending.lock().unwrap();
        pending.closed = true;
        pending.events.clear();
        pending.bytes = 0;
        drop(pending);
        self.wake.notify_one();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SubscriptionError {
    #[error("agent event subscriber lagged; resubscribe for a fresh snapshot")]
    Lagged,
}

/// Ordered live events for one independent observer. Dropping it never stops a run.
/// The first frame is the atomic initial snapshot; all later frames follow it.
/// Lag is reported once, then the stream ends. Do not apply further deltas after lag.
pub struct EventSubscription {
    pub(crate) observer: Arc<Observer>,
}

impl EventSubscription {
    pub async fn recv(&mut self) -> Option<Result<AgentEvent, SubscriptionError>> {
        loop {
            let notified = self.observer.wake.notified();
            {
                let mut pending = self.observer.pending.lock().unwrap();
                if pending.lagged {
                    pending.lagged = false;
                    return Some(Err(SubscriptionError::Lagged));
                }
                if let Some(event) = pending.events.pop_front() {
                    pending.bytes -= event.encoded_len();
                    return Some(Ok(event));
                }
                if pending.closed {
                    return None;
                }
            }
            notified.await;
        }
    }

    pub fn close(&self) {
        self.observer.close();
    }
}

impl Drop for EventSubscription {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AgentMessageDelta, agent_event};

    fn delta(text: &str) -> AgentEvent {
        AgentEvent {
            payload: Some(agent_event::Payload::AgentMessageDelta(AgentMessageDelta {
                session_id: "target".into(),
                delta: text.into(),
                ..Default::default()
            })),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn deltas_are_not_coalesced_and_bytes_are_released_after_delivery() {
        let observer = Arc::new(Observer::new("target".into()));
        let mut stream = EventSubscription {
            observer: observer.clone(),
        };
        for text in ["你", "好", "!"] {
            observer.publish(delta(text));
        }
        for text in ["你", "好", "!"] {
            assert_eq!(stream.recv().await, Some(Ok(delta(text))));
        }
        for _ in 0..3 {
            let event = delta(&"a".repeat(MAX_PENDING_BYTES / 2));
            observer.publish(event.clone());
            assert_eq!(stream.recv().await, Some(Ok(event)));
        }
        observer.close();
        assert_eq!(stream.recv().await, None);
    }

    #[tokio::test]
    async fn byte_limit_terminates_even_before_count_limit() {
        let observer = Arc::new(Observer::new("target".into()));
        let mut stream = EventSubscription {
            observer: observer.clone(),
        };
        observer.publish(delta(&"a".repeat(MAX_PENDING_BYTES)));
        assert_eq!(stream.recv().await, Some(Err(SubscriptionError::Lagged)));
        assert_eq!(stream.recv().await, None);
    }

    #[tokio::test]
    async fn session_filter_uses_business_ids_for_text_deltas() {
        let observer = Arc::new(Observer::new("target".into()));
        let mut stream = EventSubscription {
            observer: observer.clone(),
        };
        for session_id in ["other", "target"] {
            observer.publish(AgentEvent {
                payload: Some(agent_event::Payload::AgentMessageDelta(AgentMessageDelta {
                    session_id: session_id.into(),
                    delta: session_id.into(),
                    ..Default::default()
                })),
                ..Default::default()
            });
        }
        let event = stream.recv().await.unwrap().unwrap();
        let Some(agent_event::Payload::AgentMessageDelta(delta)) = event.payload else {
            panic!("missing delta");
        };
        assert_eq!(delta.session_id, "target");
        assert_eq!(delta.delta, "target");
    }

    #[test]
    fn oversized_initial_snapshot_is_rejected_before_stream_is_exposed() {
        let observer = Observer::new("target".into());
        assert_eq!(
            observer.initialize(delta(&"a".repeat(MAX_PENDING_BYTES))),
            Err(AgentError::ResourceExhausted("subscription snapshot"))
        );
        assert!(!observer.is_closed());
        assert!(observer.pending.lock().unwrap().events.is_empty());
    }

    #[tokio::test]
    async fn slow_subscriber_lags_without_blocking_another_subscriber() {
        let slow = Arc::new(Observer::new("target".into()));
        let fast = Arc::new(Observer::new("target".into()));
        let mut slow_stream = EventSubscription { observer: slow.clone() };
        let mut fast_stream = EventSubscription { observer: fast.clone() };

        for _ in 0..MAX_PENDING + 1 {
            let event = delta("next");
            slow.publish(event.clone());
            fast.publish(event.clone());
            assert_eq!(fast_stream.recv().await, Some(Ok(event)));
        }
        assert_eq!(slow_stream.recv().await, Some(Err(SubscriptionError::Lagged)));
        assert_eq!(slow_stream.recv().await, None);
        fast.publish(delta("still live"));
        assert_eq!(fast_stream.recv().await, Some(Ok(delta("still live"))));
    }
}
