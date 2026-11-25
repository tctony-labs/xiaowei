use xw_agent_types as domain;

use crate::{
    AgentError, AgentService, InputSource,
    execution::event,
    protocol::*,
    service::{State, now_ms},
    session::{Session, parse_id},
};

#[derive(Clone)]
pub(crate) struct PendingInput {
    pub accepted: domain::InputAccepted,
    pub message: domain::RecordedMessage,
    pub mode: domain::InputMode,
    pub target: Option<domain::RunId>,
}

impl PendingInput {
    pub fn view(&self) -> QueuedInput {
        let domain::AgentMessage::User(user) = &self.message.message else {
            unreachable!("queue holds user messages")
        };
        QueuedInput {
            input_id: self.accepted.input_id.to_string(),
            input: user
                .content
                .iter()
                .filter_map(|block| match block {
                    domain::ContentBlock::Text { text, .. } => Some(AgentUserInput {
                        content: Some(agent_user_input::Content::Text(text.clone())),
                    }),
                    _ => None,
                })
                .collect(),
            mode: match self.mode {
                domain::InputMode::FollowUp => QueuedInputMode::FollowUp,
                domain::InputMode::Steering => QueuedInputMode::Steering,
                domain::InputMode::Interrupt => QueuedInputMode::Interrupting,
                domain::InputMode::Send => unreachable!(),
            }
            .into(),
            run_id: self.target.map(|id| id.to_string()),
        }
    }
}

pub(crate) fn publish(state: &mut State, id: domain::SessionId) {
    let session = state.sessions.get_mut(&id).expect("loaded session");
    session.view.queued_inputs = session
        .queue
        .iter()
        .filter(|input| session.active.is_none() || !reserved(session, input.accepted.input_id))
        .map(PendingInput::view)
        .collect();
    let queued_inputs = session.view.queued_inputs.clone();
    let error = session.view.queue_error.clone();
    AgentService::publish(
        state,
        event(agent_event::Payload::QueueUpdated(QueueUpdated {
            session_id: id.to_string(),
            queued_inputs,
            error,
        })),
    );
}

pub(crate) fn steering_input(session: &Session, run_id: domain::RunId) -> Option<&PendingInput> {
    session
        .queue
        .iter()
        .find(|input| input.mode == domain::InputMode::Steering && input.target == Some(run_id))
}

fn reserved(session: &Session, input_id: domain::InputId) -> bool {
    session.dispatching == Some(input_id)
        || session
            .active
            .as_ref()
            .is_some_and(|run| run.first_inputs.contains(&input_id))
}

pub(crate) fn finish_dispatch(session: &mut Session, id: domain::InputId) {
    if session.dispatching == Some(id) {
        session.queue.retain(|entry| entry.accepted.input_id != id);
        session.dispatching = None;
        session.dispatch_manual = false;
        session.view.queue_error = None;
    }
}

fn recorded(id: domain::InputId, inputs: &[AgentUserInput], at: i64) -> domain::RecordedMessage {
    let content = inputs
        .iter()
        .map(|input| match &input.content {
            Some(agent_user_input::Content::Text(text)) => domain::ContentBlock::Text {
                text: text.clone(),
                signature: None,
            },
            _ => unreachable!("validated text"),
        })
        .collect::<Vec<_>>();
    domain::RecordedMessage {
        message_id: domain::MessageId::new(),
        block_ids: content.iter().map(|_| domain::BlockId::new()).collect(),
        run_id: None,
        turn_id: None,
        gen_id: None,
        input_id: Some(id),
        completeness: domain::MessageCompleteness::Complete,
        message: domain::AgentMessage::User(domain::UserMessage {
            content,
            timestamp_ms: at,
        }),
    }
}

fn session<'a>(state: &'a mut State, id: domain::SessionId) -> Result<&'a mut Session, AgentError> {
    let session = state
        .sessions
        .get_mut(&id)
        .filter(|session| !session.deleted())
        .ok_or(AgentError::NotFound("session"))?;
    session.available()?;
    session.prepare_writer()?;
    Ok(session)
}

fn commit(session: &mut Session, payload: domain::EntryPayload, at: i64) -> Result<(), AgentError> {
    if let Err(error) = session.append(payload, at) {
        if let Some(active) = &session.active {
            active.cancellation.cancel();
            session.failed_run = Some(active.run_id);
        }
        return Err(error);
    }
    Ok(())
}

impl AgentService {
    pub async fn queue_input(
        &self,
        request: QueueInputRequest,
        source: InputSource,
    ) -> Result<QueueInputResponse, AgentError> {
        let start = StartRunRequest {
            session_id: request.session_id.clone(),
            input_id: request.input_id.clone(),
            input: request.input.clone(),
            ..Default::default()
        };
        let id = crate::input::validate(&start, &source)?;
        let input_id = parse_id(&request.input_id, "input_id")?;
        let _gate = match &self.index {
            Some(index) => Some(index.gate.lock().await),
            None => None,
        };
        if self.index.is_some() {
            self.require(&request.session_id).await?;
        }
        let mut state = self.state()?;
        let session = session(&mut state, id)?;
        if let Some(original) = session.requests.get(&input_id) {
            if original != &start {
                return Err(AgentError::Conflict("input identity"));
            }
            let pending = session
                .queue
                .iter()
                .find(|input| input.accepted.input_id == input_id)
                .ok_or(AgentError::Conflict("input already consumed"))?;
            return Ok(QueueInputResponse {
                input: Some(pending.view()),
            });
        }
        if session
            .active
            .as_ref()
            .is_none_or(|active| active.committed)
        {
            return Err(AgentError::Conflict("session is not running"));
        }
        if session.queue.len() >= 128 {
            return Err(AgentError::ResourceExhausted("queued inputs"));
        }
        let at = now_ms()?;
        let message = recorded(input_id, &request.input, at);
        let accepted = domain::InputAccepted {
            input_id,
            source,
            mode: domain::InputMode::FollowUp,
            expected_run_id: None,
            expected_head: None,
            selection: None,
            message: message.clone(),
        };
        commit(
            session,
            domain::EntryPayload::InputAccepted(accepted.clone()),
            at,
        )?;
        let pending = PendingInput {
            accepted,
            message,
            mode: domain::InputMode::FollowUp,
            target: None,
        };
        let view = pending.view();
        session.queue.push(pending);
        session.requests.insert(input_id, start);
        session.view.queue_error = None;
        publish(&mut state, id);
        log::debug!("Agent input queued session={id} input={input_id}");
        Ok(QueueInputResponse { input: Some(view) })
    }

    pub async fn edit_queued_input(
        &self,
        request: EditQueuedInputRequest,
        source: InputSource,
    ) -> Result<QueueMutationResponse, AgentError> {
        let start = StartRunRequest {
            session_id: request.session_id.clone(),
            input_id: request.input_id.clone(),
            input: request.input,
            ..Default::default()
        };
        let id = crate::input::validate(&start, &source)?;
        let input_id = parse_id(&start.input_id, "input_id")?;
        let _gate = match &self.index {
            Some(index) => Some(index.gate.lock().await),
            None => None,
        };
        if self.index.is_some() {
            self.require(&start.session_id).await?;
        }
        let mut state = self.state()?;
        let session = session(&mut state, id)?;
        let position = session
            .queue
            .iter()
            .position(|input| input.accepted.input_id == input_id)
            .ok_or(AgentError::Conflict("input not queued"))?;
        if reserved(session, input_id) {
            return Err(AgentError::Conflict("input dispatching"));
        }
        let at = now_ms()?;
        let message = recorded(input_id, &start.input, at);
        commit(
            session,
            domain::EntryPayload::InputEdited(domain::InputEdited {
                input_id,
                message: message.clone(),
            }),
            at,
        )?;
        session.queue[position].message = message;
        session.view.queue_error = None;
        publish(&mut state, id);
        Ok(QueueMutationResponse {
            queued_inputs: state.sessions[&id].view.queued_inputs.clone(),
        })
    }

    pub async fn steer_input(
        &self,
        request: QueuedInputActionRequest,
    ) -> Result<QueueMutationResponse, AgentError> {
        self.route_input(request, Some(domain::InputMode::Steering))
            .await
    }

    pub async fn interrupt_input(
        &self,
        request: QueuedInputActionRequest,
    ) -> Result<QueueMutationResponse, AgentError> {
        if request.run_id.is_none() {
            return self.send_queued_input(request).await;
        }
        self.route_input(request, Some(domain::InputMode::Interrupt))
            .await
    }

    async fn send_queued_input(
        &self,
        request: QueuedInputActionRequest,
    ) -> Result<QueueMutationResponse, AgentError> {
        let id = parse_id(&request.session_id, "session_id")?;
        let input_id = parse_id(&request.input_id, "input_id")?;
        let _gate = match &self.index {
            Some(index) => Some(index.gate.lock().await),
            None => None,
        };
        if self.index.is_some() {
            self.require(&request.session_id).await?;
        }
        let handle =
            tokio::runtime::Handle::try_current().map_err(|_| AgentError::ExecutionUnavailable)?;
        let mut state = self.state()?;
        let session = session(&mut state, id)?;
        if session.active.is_some() || session.dispatching.is_some() {
            return Err(AgentError::Conflict("session is running"));
        }
        let position = session
            .queue
            .iter()
            .position(|entry| entry.accepted.input_id == input_id)
            .ok_or(AgentError::Conflict("input not queued"))?;
        if session.queue[position].mode != domain::InputMode::FollowUp {
            commit(
                session,
                domain::EntryPayload::InputRouted(domain::InputRouted {
                    input_id,
                    mode: domain::InputMode::FollowUp,
                    expected_run_id: None,
                }),
                now_ms()?,
            )?;
            session.queue[position].mode = domain::InputMode::FollowUp;
            session.queue[position].target = None;
        }
        session.dispatching = Some(input_id);
        session.dispatch_manual = true;
        session.view.queue_error = None;
        publish(&mut state, id);
        let response = QueueMutationResponse {
            queued_inputs: state.sessions[&id].view.queued_inputs.clone(),
        };
        drop(state);
        let service = self.dispatch_handle();
        handle.spawn(async move {
            dispatch(&service, id, input_id).await;
        });
        Ok(response)
    }

    pub async fn remove_queued_input(
        &self,
        request: QueuedInputActionRequest,
    ) -> Result<QueueMutationResponse, AgentError> {
        self.route_input(request, None).await
    }

    async fn route_input(
        &self,
        request: QueuedInputActionRequest,
        mode: Option<domain::InputMode>,
    ) -> Result<QueueMutationResponse, AgentError> {
        let id = parse_id(&request.session_id, "session_id")?;
        let input_id = parse_id(&request.input_id, "input_id")?;
        let _gate = match &self.index {
            Some(index) => Some(index.gate.lock().await),
            None => None,
        };
        if self.index.is_some() {
            self.require(&request.session_id).await?;
        }
        let mut state = self.state()?;
        let session = session(&mut state, id)?;
        let position = session
            .queue
            .iter()
            .position(|input| input.accepted.input_id == input_id)
            .ok_or(AgentError::Conflict("input not queued"))?;
        if reserved(session, input_id) {
            return Err(AgentError::Conflict("input dispatching"));
        }
        let at = now_ms()?;
        if let Some(mode) = mode {
            let target = request
                .run_id
                .as_deref()
                .ok_or(AgentError::InvalidArgument("run_id"))?;
            let target = parse_id(target, "run_id")?;
            let active = session
                .active
                .as_ref()
                .filter(|active| active.run_id == target)
                .ok_or(AgentError::Conflict("run not active"))?;
            if active.committed {
                return Err(AgentError::Conflict("run already settled"));
            }
            if session.queue.iter().any(|entry| {
                entry.mode == domain::InputMode::Interrupt && entry.accepted.input_id != input_id
            }) {
                return Err(AgentError::Conflict("interrupt already pending"));
            }
            let cancellation = active.cancellation.clone();
            commit(
                session,
                domain::EntryPayload::InputRouted(domain::InputRouted {
                    input_id,
                    mode,
                    expected_run_id: Some(target),
                }),
                at,
            )?;
            session.queue[position].mode = mode;
            session.queue[position].target = Some(target);
            if mode == domain::InputMode::Interrupt {
                cancellation.cancel();
            }
        } else {
            commit(
                session,
                domain::EntryPayload::InputCancelled(domain::InputCancelled {
                    input_id,
                    reason: domain::InputCancelReason::User,
                }),
                at,
            )?;
            session.queue.remove(position);
        }
        session.view.queue_error = None;
        publish(&mut state, id);
        log::debug!("Agent queue updated session={id} input={input_id} mode={mode:?}");
        Ok(QueueMutationResponse {
            queued_inputs: state.sessions[&id].view.queued_inputs.clone(),
        })
    }
}

pub(crate) async fn dispatch(
    service: &AgentService,
    session_id: domain::SessionId,
    input_id: domain::InputId,
) {
    let (request, source) = {
        let Ok(state) = service.state() else { return };
        let Some(session) = state.sessions.get(&session_id) else {
            return;
        };
        let Some(input) = session
            .queue
            .iter()
            .find(|input| input.accepted.input_id == input_id)
        else {
            return;
        };
        (
            StartRunRequest {
                session_id: session_id.to_string(),
                input_id: input_id.to_string(),
                input: input.view().input,
                ..Default::default()
            },
            input.accepted.source.clone(),
        )
    };
    if let Err(error) = service.start_loaded(request, source).await {
        if let Ok(mut state) = service.state() {
            if let Some(session) = state.sessions.get_mut(&session_id)
                && session.dispatching == Some(input_id)
            {
                session.dispatching = None;
                session.dispatch_manual = false;
                session.view.queue_error = Some("排队消息发送失败，请检查会话。".into());
                publish(&mut state, session_id);
            }
        }
        log::warn!(
            "Agent queued input dispatch failed session={session_id} input={input_id}: {error}"
        );
    }
}
