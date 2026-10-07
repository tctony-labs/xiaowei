use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::{SystemTime, UNIX_EPOCH},
};

use prost::Message;
use xw_agent_types::{ClientRequestId, RunId, SessionId};

use crate::{
    AgentError, AgentHost, EventSubscription, LlmGeneration,
    events::Observer,
    input,
    protocol::*,
    session::{MAX_CREATIONS, MAX_SESSIONS, Session, parse_id},
};

const MAX_OBSERVERS: usize = 64;

pub(crate) struct State {
    pub(crate) closed: bool,
    pub(crate) sessions: BTreeMap<SessionId, Session>,
    pub(crate) creations: BTreeMap<ClientRequestId, (SessionId, AgentModelConfig)>,
    pub(crate) observers: Vec<Weak<Observer>>,
    pub(crate) viewers: BTreeMap<SessionId, Vec<Weak<()>>>,
}

/// Owns memory state and public protocol methods, without a transport registry.
pub struct AgentService {
    pub(crate) generation: Arc<dyn LlmGeneration>,
    pub(crate) host: Arc<dyn AgentHost>,
    pub(crate) index: Option<Arc<crate::index::IndexAccess>>,
    pub(crate) rollout: Option<xw_agent_rollout::RolloutStore>,
    pub(crate) state: Arc<Mutex<State>>,
    pub(crate) maintenance: Mutex<Option<crate::retention::MaintenanceTask>>,
}

impl AgentService {
    pub fn new(host: Arc<dyn AgentHost>) -> Self {
        Self {
            generation: Arc::new(crate::host::HostGeneration(host.clone())),
            host,
            index: None,
            rollout: None,
            state: Arc::new(Mutex::new(State {
                closed: false,
                sessions: BTreeMap::new(),
                creations: BTreeMap::new(),
                observers: Vec::new(),
                viewers: BTreeMap::new(),
            })),
            maintenance: Mutex::new(None),
        }
    }

    pub(crate) fn state(&self) -> Result<MutexGuard<'_, State>, AgentError> {
        let state = self.state.lock().map_err(|_| AgentError::Internal)?;
        if state.closed {
            return Err(AgentError::Closed);
        }
        Ok(state)
    }

    pub(crate) fn subscribe_loaded(&self, request: SubscribeSessionRequest) -> Result<EventSubscription, AgentError> {
        let id: SessionId = parse_id(&request.session_id, "session_id")?;
        let mut state = self.state()?;
        let session = state
            .sessions
            .get(&id)
            .filter(|session| !session.deleted())
            .ok_or(AgentError::NotFound("session"))?
            .view
            .clone();
        state
            .observers
            .retain(|observer| observer.upgrade().is_some_and(|observer| !observer.is_closed()));
        if state.observers.len() >= MAX_OBSERVERS {
            return Err(AgentError::ResourceExhausted("observers"));
        }
        let initial = AgentEvent {
            emitted_at_ms: now_ms()?,
            payload: Some(agent_event::Payload::SubscriptionReady(SubscriptionReady {
                session: Some(session),
            })),
        };
        let observer = Arc::new(Observer::new(request.session_id));
        observer.initialize(initial)?;
        state.observers.push(Arc::downgrade(&observer));
        drop(state);
        self.refresh_model_info(id);
        Ok(EventSubscription { observer })
    }

    pub(crate) async fn create_loaded_with_source(
        &self,
        request: CreateSessionRequest,
        source: crate::InputSource,
    ) -> Result<CreateSessionResponse, AgentError> {
        if source.principal_id.trim().is_empty() {
            return Err(AgentError::InvalidArgument("source.principal_id"));
        }
        let request_id: ClientRequestId = parse_id(&request.client_request_id, "client_request_id")?;
        let config = request.config.ok_or(AgentError::InvalidArgument("config"))?;
        input::validate_config(&config)?;
        let info = self.host.get_model_info(config.model_ref.clone()).await;
        let mut state = self.state()?;
        if let Some((id, original_config)) = state.creations.get(&request_id) {
            let session = &state.sessions[id];
            if original_config != &config {
                return Err(AgentError::Conflict("creation config"));
            }
            return Ok(CreateSessionResponse {
                session: Some(session.view.clone()),
            });
        }
        if self.index.is_none() && state.creations.len() >= MAX_CREATIONS {
            return Err(AgentError::ResourceExhausted("session creation identities"));
        }
        if self.index.is_none() && state.sessions.values().filter(|session| !session.deleted()).count() >= MAX_SESSIONS
        {
            return Err(AgentError::ResourceExhausted("sessions"));
        }

        let created_at_ms = now_ms()?;
        let id = SessionId::new();
        let mut session = Session::new(id, created_at_ms, config.clone());
        crate::model::apply_info(&mut session, &config.model_ref, info);
        session.indexed = self.index.is_some();
        if let Some(store) = &self.rollout {
            let meta = crate::persistence::initial_meta(&session);
            let journal = store
                .create(id, created_at_ms, meta.clone())
                .map_err(crate::persistence::storage_error)?;
            session.meta = Some(meta);
            session.journal = Some(journal);
        }
        let response = CreateSessionResponse {
            session: Some(session.view.clone()),
        };
        let event = AgentEvent {
            emitted_at_ms: created_at_ms,
            payload: Some(agent_event::Payload::SessionStarted(SessionStarted {
                session: Some(session.view.clone()),
            })),
        };
        state.sessions.insert(id, session);
        state.creations.insert(request_id, (id, config));
        Self::publish(&mut state, event);
        log::debug!("Agent session created session={id}");
        Ok(response)
    }

    pub(crate) fn list_loaded(&self, request: ListSessionsRequest) -> Result<ListSessionsResponse, AgentError> {
        let state = self.state()?;
        let query = request.query.trim().to_lowercase();
        if request.query.trim().len() > 256 {
            return Err(AgentError::InvalidArgument("query"));
        }
        let mut sessions = state
            .sessions
            .values()
            .filter(|session| {
                !session.deleted()
                    && session.view.archived == request.archived
                    && session.view.title.to_lowercase().contains(&query)
            })
            .map(|session| AgentSessionSummary {
                session_id: session.view.session_id.clone(),
                status: session.view.status,
                created_at_ms: session.view.created_at_ms,
                metadata_revision: session.view.metadata_revision,
                title: session.view.title.clone(),
                auto_title_enabled: session.view.auto_title_enabled,
                archived: session.view.archived,
                archive_revision: session.view.archive_revision,
                updated_at_ms: session.view.updated_at_ms,
            })
            .collect::<Vec<_>>();
        sessions.sort_by(|a, b| {
            b.created_at_ms
                .cmp(&a.created_at_ms)
                .then_with(|| b.session_id.cmp(&a.session_id))
        });
        Ok(ListSessionsResponse {
            sessions,
            continuation: String::new(),
        })
    }

    pub(crate) fn read_loaded(&self, request: ReadSessionRequest) -> Result<ReadSessionResponse, AgentError> {
        let id: SessionId = parse_id(&request.session_id, "session_id")?;
        let state = self.state()?;
        let session = state
            .sessions
            .get(&id)
            .filter(|session| !session.deleted())
            .map(|session| {
                let mut view = session.view.clone();
                if !request.include_runs {
                    view.runs.clear();
                }
                view
            });
        if session
            .as_ref()
            .is_some_and(|session| session.encoded_len() > 1024 * 1024)
        {
            return Err(AgentError::ResourceExhausted("session snapshot"));
        }
        Ok(ReadSessionResponse {
            found: session.is_some(),
            session,
        })
    }

    pub(crate) async fn delete_loaded(&self, request: DeleteSessionTarget) -> Result<bool, AgentError> {
        let id: SessionId = parse_id(&request.session_id, "session_id")?;
        if request.expected_metadata_revision == 0 {
            return Err(AgentError::InvalidArgument("expected_metadata_revision"));
        }
        let done = {
            let mut state = self.state()?;
            let Some(session) = state.sessions.get_mut(&id) else {
                return Ok(false);
            };
            if let Some(expected) = request.expected_archive_revision {
                if !session.view.archived {
                    return Err(AgentError::Conflict("session not archived"));
                }
                if expected != session.view.archive_revision {
                    return Err(AgentError::Conflict("archive revision"));
                }
            }
            if request.expected_metadata_revision != session.view.metadata_revision {
                return Err(AgentError::Conflict("metadata revision"));
            }
            session.delete();
            let mut done = session
                .title_tasks
                .values()
                .map(|task| task.done.clone())
                .collect::<Vec<_>>();
            if let Some(a) = &session.active {
                a.cancellation.cancel();
                done.push(a.done.clone());
            }
            done
        };
        for done in done {
            done.cancelled().await;
        }
        let mut state = self.state()?;
        let session = state.sessions.get_mut(&id).ok_or(AgentError::NotFound("session"))?;
        if session.deletion_announced {
            return Ok(true);
        }
        if let Some(journal) = &mut session.journal {
            journal.delete(now_ms()?).map_err(crate::persistence::storage_error)?;
        }
        session.journal = None;
        session.deletion_announced = true;
        session.history.clear();
        session.view.runs.clear();
        session.requests.clear();
        Self::publish(
            &mut state,
            AgentEvent {
                emitted_at_ms: now_ms()?,
                payload: Some(agent_event::Payload::SessionDeleted(SessionDeleted {
                    session_id: id.to_string(),
                })),
            },
        );
        log::debug!("Agent session deleted session={id}");
        Ok(true)
    }

    pub fn interrupt_run(&self, request: InterruptRunRequest) -> Result<InterruptRunResponse, AgentError> {
        let id: SessionId = parse_id(&request.session_id, "session_id")?;
        let run_id: RunId = parse_id(&request.run_id, "run_id")?;
        let state = self.state()?;
        let Some(session) = state.sessions.get(&id).filter(|s| !s.deleted()) else {
            return Ok(InterruptRunResponse::default());
        };
        let found = session.view.runs.iter().any(|r| r.run_id == run_id.to_string());
        let active = session.active.as_ref().filter(|a| a.run_id == run_id);
        if let Some(active) = active {
            active.cancellation.cancel();
        }
        Ok(InterruptRunResponse {
            found,
            cancellation_requested: active.is_some(),
        })
    }

    pub fn cancel_all(&self) {
        self.cancel_maintenance();
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            for session in state.sessions.values_mut() {
                session.cancel_titles();
                if let Some(active) = &session.active {
                    active.cancellation.cancel();
                }
            }
        }
    }

    pub async fn close(&self) -> Result<(), AgentError> {
        self.stop_maintenance().await;
        let done = {
            let mut state = self.state.lock().map_err(|_| AgentError::Internal)?;
            state.closed = true;
            state
                .sessions
                .values_mut()
                .flat_map(|session| {
                    session.cancel_titles();
                    let mut done = session
                        .title_tasks
                        .values()
                        .map(|task| task.done.clone())
                        .collect::<Vec<_>>();
                    if let Some(active) = &session.active {
                        active.cancellation.cancel();
                        done.push(active.done.clone());
                    }
                    done
                })
                .collect::<Vec<_>>()
        };
        for done in done {
            done.cancelled().await;
        }
        if let Some(index) = &self.index {
            let _gate = index.gate.lock().await;
            index.storage.close().await;
        }
        self.close_state()
    }

    fn close_state(&self) -> Result<(), AgentError> {
        let mut state = self.state.lock().map_err(|_| AgentError::Internal)?;
        state.closed = true;
        for session in state.sessions.values_mut() {
            session.cancel_titles();
            if let Some(active) = &session.active {
                active.cancellation.cancel();
            }
        }
        for observer in state.observers.drain(..).filter_map(|observer| observer.upgrade()) {
            observer.close();
        }
        state.sessions.clear();
        state.creations.clear();
        state.viewers.clear();
        log::debug!("Agent service closed");
        Ok(())
    }

    pub(crate) fn publish(state: &mut State, event: AgentEvent) {
        state.observers.retain(|observer| {
            if let Some(observer) = observer.upgrade() {
                observer.publish(event.clone());
                true
            } else {
                false
            }
        });
    }
}

impl Drop for AgentService {
    fn drop(&mut self) {
        self.cancel_maintenance();
        let _ = self.close_state();
    }
}

pub(crate) fn now_ms() -> Result<i64, AgentError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AgentError::Internal)?;
    i64::try_from(now.as_millis()).map_err(|_| AgentError::Internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CancellationToken, GenerationFuture, GenerationRequest};
    use futures_util::FutureExt;
    use xw_agent_types::{BlockId, InputId};

    struct NeverGenerate;

    impl AgentHost for NeverGenerate {
        fn get_model_info(&self, _: String) -> crate::ModelInfoFuture {
            Box::pin(async { Err(crate::ModelInfoError::Unavailable) })
        }
        fn get_auxiliary_model_ref(&self) -> crate::AuxiliaryModelRefFuture {
            Box::pin(async { Ok(None) })
        }
        fn generate(&self, _: GenerationRequest, _: CancellationToken) -> GenerationFuture {
            panic!("snapshot tests must not start generation")
        }
    }

    #[tokio::test]
    async fn initial_item_text_and_subsequent_delta_do_not_overlap() {
        let service = AgentService::new(Arc::new(NeverGenerate));
        let session = service
            .create_session(CreateSessionRequest {
                title_model_ref: String::new(),
                client_request_id: ClientRequestId::new().to_string(),
                config: Some(AgentModelConfig {
                    model_ref: "test".into(),
                    reasoning: None,
                }),
            })
            .now_or_never()
            .expect("memory operation completes immediately")
            .unwrap()
            .session
            .unwrap();
        let session_id: SessionId = session.session_id.parse().unwrap();
        let run_id = RunId::new().to_string();
        let item_id = BlockId::new().to_string();
        {
            let mut state = service.state().unwrap();
            // Seed a display projection; execution remains disconnected in step 1.
            state.sessions.get_mut(&session_id).unwrap().view.runs.push(AgentRun {
                run_id: run_id.clone(),
                input_id: InputId::new().to_string(),
                status: AgentRunStatus::InProgress.into(),
                items: vec![AgentItem {
                    item_id: item_id.clone(),
                    content: Some(agent_item::Content::AgentMessage(AgentMessage {
                        text: "before".into(),
                    })),
                }],
                ..Default::default()
            });
        }

        let mut stream = service
            .subscribe_session(SubscribeSessionRequest {
                session_id: session.session_id.clone(),
            })
            .now_or_never()
            .expect("memory operation completes immediately")
            .unwrap();
        {
            let mut state = service.state().unwrap();
            let view = &mut state.sessions.get_mut(&session_id).unwrap().view;
            let Some(agent_item::Content::AgentMessage(message)) = &mut view.runs[0].items[0].content else {
                unreachable!();
            };
            message.text.push_str("after");
            AgentService::publish(
                &mut state,
                AgentEvent {
                    emitted_at_ms: now_ms().unwrap(),
                    payload: Some(agent_event::Payload::AgentMessageDelta(AgentMessageDelta {
                        session_id: session.session_id,
                        run_id,
                        item_id,
                        delta: "after".into(),
                    })),
                },
            );
        }

        let initial = stream.recv().await.unwrap().unwrap();
        let Some(agent_event::Payload::SubscriptionReady(ready)) = initial.payload else {
            panic!("missing initial snapshot");
        };
        let Some(agent_item::Content::AgentMessage(message)) =
            &ready.session.as_ref().unwrap().runs[0].items[0].content
        else {
            panic!("missing item text");
        };
        assert_eq!(message.text, "before");

        let event = stream.recv().await.unwrap().unwrap();
        let Some(agent_event::Payload::AgentMessageDelta(delta)) = event.payload else {
            panic!("missing following delta");
        };
        assert_eq!(format!("{}{}", message.text, delta.delta), "beforeafter");
    }
}
