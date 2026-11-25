use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};

use prost::Message;
use tokio::sync::mpsc;
use xw_agent_runtime::{
    RunRequest, RunStatus,
    context_budget::{ContextBudget, ContextSample, context_tokens},
    execute_text,
    tools::FileTools,
};
use xw_agent_types as domain;

use crate::{
    AgentError, AgentHost, AgentService, CancellationToken, GenerationEvent, LlmGeneration,
    execution::{
        MAX_DISPLAY_BYTES, MAX_HISTORY_BYTES, display_item, event, generation_update,
        project_update,
    },
    index::IndexAccess,
    protocol::*,
    service::{State, now_ms},
};

pub(crate) struct RunPlan {
    pub request: RunRequest,
    pub model: domain::ModelDescriptor,
    pub sample: Option<ContextSample>,
    pub pending_first: Option<Vec<(domain::InputId, domain::AgentMessage)>>,
}

pub(crate) async fn execute(
    dispatcher: AgentService,
    shared: Arc<Mutex<State>>,
    index: Option<Arc<IndexAccess>>,
    host: Arc<dyn AgentHost>,
    generation: Arc<dyn LlmGeneration>,
    mut plan: RunPlan,
    cancellation: CancellationToken,
    done: CancellationToken,
) {
    let _done = done.drop_guard();
    let started = Instant::now();
    let session_id = plan.request.session_id;
    let result = drive(
        &shared,
        host.clone(),
        generation,
        &mut plan,
        &cancellation,
        started,
    )
    .await;
    let request = &plan.request;
    if cancellation.is_cancelled() {
        let pending = shared
            .lock()
            .unwrap()
            .sessions
            .get(&session_id)
            .map(|session| session.background.cancel(Some(request.run_id)))
            .unwrap_or_default();
        for shell in pending {
            shell.cancelled().await;
        }
    }
    let failed_commit = result.is_err();
    let (status, error) = match result {
        Ok((RunStatus::Completed, _)) => (AgentRunStatus::Completed, None),
        Ok((RunStatus::Cancelled, _)) => (AgentRunStatus::Interrupted, None),
        Ok((RunStatus::Failed, error)) => (AgentRunStatus::Failed, error),
        Err(error) => (AgentRunStatus::Failed, Some(error.to_string())),
    };
    let mut dispatch = None;
    {
        let mut state = shared.lock().unwrap();
        let closed = state.closed;
        let Some(session) = state.sessions.get_mut(&session_id) else {
            return;
        };
        if session.deleted() {
            session.active = None;
            return;
        }
        if failed_commit {
            session.failed_run = Some(request.run_id);
        }
        let run = session.view.runs.last_mut().expect("accepted run");
        run.status = status.into();
        run.error = error;
        run.generation = None;
        run.final_gen_id =
            (status == AgentRunStatus::Completed).then(|| request.gen_id.to_string());
        for item in &mut run.items {
            if let Some(agent_item::Content::ToolCall(tool)) = &mut item.content
                && tool.status == AgentToolStatus::Pending as i32
            {
                tool.status = AgentToolStatus::ResultUnknown.into();
            }
        }
        run.completed_at_ms = Some(now_ms().unwrap_or_default());
        let run = run.clone();
        let reserved_inputs = session
            .active
            .take()
            .is_some_and(|run| !run.first_inputs.is_empty());
        let released_dispatch = session.dispatching == Some(request.input_id);
        if released_dispatch {
            session.dispatching = None;
            session.dispatch_manual = false;
        }
        session.view.status = AgentSessionStatus::Idle.into();
        session.view.updated_at_ms = session.view.updated_at_ms.max(run.completed_at_ms.unwrap());
        if !closed && !failed_commit && session.failed_run.is_none() && !session.frozen {
            let next = if status == AgentRunStatus::Interrupted {
                session.queue.iter().find(|input| {
                    input.mode == domain::InputMode::Interrupt
                        && input.target == Some(request.run_id)
                })
            } else if status == AgentRunStatus::Completed {
                session
                    .queue
                    .first()
                    .filter(|input| input.mode == domain::InputMode::FollowUp)
            } else {
                None
            };
            if let Some(input) = next {
                let id = input.accepted.input_id;
                session.dispatching = Some(id);
                dispatch = Some(id);
            }
        }
        if released_dispatch || reserved_inputs {
            crate::queue::publish(&mut state, session_id);
        }
        AgentService::publish(
            &mut state,
            event(agent_event::Payload::RunCompleted(RunCompleted {
                session_id: session_id.to_string(),
                run: Some(crate::history::completed_run(&run)),
            })),
        );
        log::debug!(
            "Agent Run settled session={session_id} run={} status={status:?}",
            request.run_id
        );
        let session = &state.sessions[&session_id];
        if !state.closed
            && !session.frozen
            && session.failed_run.is_none()
            && session.view.auto_title_enabled
            && crate::title::has_output(&run)
            && let Some(current) = crate::title::title_generation(session)
        {
            let round = current.round;
            if crate::title::last_title_in_recent_page(session)
                .is_none_or(|previous| round.saturating_sub(previous.round) >= 3)
            {
                if let Err(error) = crate::title::schedule_title(
                    &mut state,
                    shared.clone(),
                    host,
                    index.clone(),
                    session_id,
                    false,
                ) {
                    log::debug!("Agent automatic title skipped session={session_id}: {error}");
                } else {
                    log::debug!(
                        "Agent automatic title scheduled session={session_id} round={round}"
                    );
                }
            }
        }
        let session = state
            .sessions
            .get_mut(&session_id)
            .expect("settled session");
        if session.failed_run.is_none() {
            match session.archive_display() {
                Ok(()) => {
                    if let Some(journal) = &mut session.journal {
                        journal.release_completed_contents();
                    }
                }
                Err(error) => {
                    log::warn!("Agent display index update delayed session={session_id}: {error}");
                }
            }
        }
    }
    if let Some(index) = index {
        let _gate = index.gate.lock().await;
        let _ = crate::index::flush(&shared, &index, session_id).await;
    }
    if let Some(input_id) = dispatch {
        crate::queue::dispatch(&dispatcher, session_id, input_id).await;
    }
}

async fn drive(
    shared: &Arc<Mutex<State>>,
    host: Arc<dyn AgentHost>,
    generation: Arc<dyn LlmGeneration>,
    plan: &mut RunPlan,
    cancellation: &CancellationToken,
    started: Instant,
) -> Result<(RunStatus, Option<String>), AgentError> {
    let RunPlan {
        request,
        model,
        sample,
        pending_first,
    } = plan;
    if let Some(inputs) = pending_first.take() {
        let (ids, upcoming): (Vec<_>, Vec<_>) = inputs.into_iter().unzip();
        let result = crate::compaction::compact_if_needed(
            shared,
            request,
            model,
            &upcoming,
            sample,
            None,
            generation.clone(),
            cancellation,
        )
        .await?;
        let mut state = shared.lock().unwrap();
        if cancellation.is_cancelled() || result.is_err() {
            drop(state);
            return settle_preflight(shared, request, cancellation, result, started, 0);
        }
        let session = state.sessions.get_mut(&request.session_id).unwrap();
        let at = now_ms()?;
        session.record_first_turn(request, &ids, at)?;
        session.history.extend(upcoming);
        request.generation.messages = session.history.clone();
        crate::queue::finish_dispatch(session, request.input_id);
        session
            .queue
            .retain(|input| !ids.contains(&input.accepted.input_id));
        session
            .active
            .as_mut()
            .expect("active Run")
            .first_inputs
            .clear();
        let update = opening_generation(session, request, at);
        crate::queue::publish(&mut state, request.session_id);
        AgentService::publish(&mut state, event(update));
    }
    let (
        cwd,
        permission_mode,
        history,
        mut grants,
        todo_metadata,
        registered,
        exposed,
        shells,
        repeat_guard,
    ) = {
        let state = shared.lock().unwrap();
        let session = &state.sessions[&request.session_id];
        let todo_metadata = crate::history::latest_todo(&session.view.runs).unwrap_or_else(|| {
            session
                .display_history
                .as_ref()
                .and_then(|history| history.todo_metadata.clone())
        });
        (
            session.view.cwd.clone(),
            session
                .active
                .as_ref()
                .expect("accepted run")
                .permission_mode,
            session.history.clone(),
            session.granted_paths.clone(),
            todo_metadata,
            session.tools.clone(),
            crate::tool_registry::context(session)?
                .tools
                .into_iter()
                .map(|tool| tool.name)
                .collect::<std::collections::BTreeSet<_>>(),
            session.background.clone(),
            crate::continuation::repeat_guard(session, request.run_id),
        )
    };
    let mut todos = xw_agent_runtime::tools::todo::TodoWrite::restore(todo_metadata.as_deref())
        .map_err(|_| AgentError::Persistence)?;
    let tools = cwd.as_ref().map(|cwd| {
        Arc::new(Mutex::new(FileTools::new(
            PathBuf::from(cwd),
            permission_mode,
            grants.clone(),
            &history,
        )))
    });
    let mut used = 0u32;
    let mut ordinal = 1;
    loop {
        let turn_started = Instant::now();
        let base_items = {
            let state = shared.lock().unwrap();
            state.sessions[&request.session_id]
                .view
                .runs
                .last()
                .unwrap()
                .items
                .len()
        };
        let (tx, mut rx) = mpsc::channel(32);
        // The generation may cancel its child; the Run token must survive TOOL_USE.
        let future = execute_text(
            request.clone(),
            generation.clone(),
            cancellation.child_token(),
            tx,
        );
        tokio::pin!(future);
        let mut blocks = BTreeMap::new();
        let mut storage_failed = false;
        let mut first_sse_committed = false;
        let mut display_failed = false;
        let mut outcome = loop {
            tokio::select! {
                biased;
                Some(update) = rx.recv() => {
                    if storage_failed || display_failed { continue; }
                    let mut state = shared.lock().unwrap();
                    let session = state.sessions.get_mut(&request.session_id).unwrap();
                    if let GenerationEvent::FirstSseReceived { received_at_ms } = &update.event {
                        if session.append(domain::EntryPayload::GenFirstSseReceived(
                            domain::GenFirstSseReceived { gen_id: request.gen_id,
                                received_at_ms: *received_at_ms }), *received_at_ms).is_err()
                        {
                            storage_failed = true;
                            cancellation.cancel();
                            continue;
                        }
                        first_sse_committed = true;
                    }
                    let previous = session.view.runs.last().unwrap().clone();
                    let changes = project_update(
                        request.session_id,
                        session.view.runs.last_mut().unwrap(),
                        update.event,
                        &mut blocks,
                        base_items,
                    );
                    if session.view.encoded_len() > MAX_DISPLAY_BYTES - 2048 {
                        *session.view.runs.last_mut().unwrap() = previous;
                        display_failed = true;
                        cancellation.cancel();
                    } else {
                        for change in changes { AgentService::publish(&mut state, event(change)); }
                    }
                }
                outcome = &mut future => break outcome,
            }
        };
        if storage_failed {
            return Err(AgentError::Persistence);
        }
        let calls = outcome.message.as_ref().map_or(0, |message| {
            message
                .content
                .iter()
                .filter(|block| matches!(block, domain::ContentBlock::ToolCall { .. }))
                .count()
        });
        if display_failed || calls > (50 - used) as usize {
            outcome.status = RunStatus::Failed;
            outcome.error = Some(crate::GenerationError::Failed(if display_failed {
                "display history budget exceeded".into()
            } else {
                "tool call limit exceeded (50 per Run)".into()
            }));
            outcome.partial = outcome
                .message
                .take()
                .map_or(outcome.partial, |m| m.content);
        }
        let final_blocks = outcome
            .message
            .as_ref()
            .map(|m| &m.content)
            .unwrap_or(&outcome.partial);
        for (index, block) in final_blocks.iter().enumerate() {
            blocks
                .entry(index as u32)
                .or_insert_with(|| (domain::BlockId::new().to_string(), block.clone()));
        }
        {
            let mut state = shared.lock().unwrap();
            let session = state.sessions.get_mut(&request.session_id).unwrap();
            if !first_sse_committed && let Some(received_at_ms) = outcome.first_sse_at_ms {
                session.append(
                    domain::EntryPayload::GenFirstSseReceived(domain::GenFirstSseReceived {
                        gen_id: request.gen_id,
                        received_at_ms,
                    }),
                    received_at_ms,
                )?;
            }
            session.record_generation(request, &outcome, &blocks)?;
            let run = session.view.runs.last_mut().unwrap();
            run.items.truncate(base_items);
            run.items.extend(
                final_blocks
                    .iter()
                    .enumerate()
                    .filter_map(|(index, block)| {
                        display_item(
                            blocks[&(index as u32)].0.clone(),
                            request.gen_id.to_string(),
                            block,
                        )
                    }),
            );
            if session.view.encoded_len() > MAX_DISPLAY_BYTES - 2048 {
                session
                    .view
                    .runs
                    .last_mut()
                    .unwrap()
                    .items
                    .truncate(base_items);
            }
            if let Some(message) = &outcome.message
                && outcome.status == RunStatus::Completed
            {
                *sample = message
                    .usage
                    .as_ref()
                    .and_then(context_tokens)
                    .map(|tokens| ContextSample {
                        tokens,
                        offset: request.generation.messages.len(),
                    });
                session
                    .history
                    .push(domain::AgentMessage::Assistant(message.clone()));
            }
            let items = session.view.runs.last().unwrap().items[base_items..].to_vec();
            session.view.runs.last_mut().unwrap().generation = None;
            let generation_ended =
                generation_update(request.session_id, session.view.runs.last().unwrap());
            for item in items {
                AgentService::publish(
                    &mut state,
                    event(agent_event::Payload::ItemCompleted(ItemCompleted {
                        session_id: request.session_id.to_string(),
                        run_id: request.run_id.to_string(),
                        item: Some(item),
                    })),
                );
            }
            AgentService::publish(&mut state, event(generation_ended));
        }
        let mut status = outcome.status;
        let mut error = outcome.error.as_ref().map(ToString::to_string);
        let mut loaded_skill = false;
        if status == RunStatus::Completed {
            for (index, block) in final_blocks.iter().enumerate() {
                let domain::ContentBlock::ToolCall {
                    id,
                    name,
                    arguments_json,
                    namespace,
                    ..
                } = block
                else {
                    continue;
                };
                let intent = domain::ToolIntent {
                    tool_id: domain::ToolId::new(),
                    key: domain::ProviderToolKey {
                        run_id: request.run_id,
                        turn_id: request.turn_id.expect("conversation Turn"),
                        gen_id: request.gen_id,
                        provider_call_id: id.clone(),
                    },
                    assistant_message_id: request.message_id,
                    block_id: blocks[&(index as u32)]
                        .0
                        .parse()
                        .map_err(|_| AgentError::Internal)?,
                    tool_name: name.clone(),
                    arguments_json: arguments_json.clone().expect("validated"),
                    generation_duration_ms: None,
                };
                commit_intent(shared, &intent)?;
                used += 1;
                let began = Instant::now();
                let steering = {
                    let state = shared.lock().unwrap();
                    state.sessions[&request.session_id]
                        .queue
                        .iter()
                        .any(|input| {
                            input.mode == domain::InputMode::Steering
                                && input.target == Some(request.run_id)
                        })
                };
                let mut skipped =
                    cancellation.is_cancelled() || status == RunStatus::Failed || steering;
                let mut skip_reason = if steering {
                    "收到补充指令，工具未执行"
                } else {
                    "运行已停止，工具未执行"
                };
                if !skipped
                    && namespace.is_none()
                    && exposed.contains(name)
                    && repeat_guard.iter().any(|old| {
                        old.tool_name == *name
                            && domain::same_tool_effect(
                                name,
                                &old.arguments_json,
                                &intent.arguments_json,
                            )
                    })
                {
                    let answer = crate::interactive::wait(
                        shared,
                        request.session_id,
                        &intent,
                        domain::InteractionRequest::ToolExecution {
                            reason: "此前运行已尝试相同操作。请确认是否再次执行。".into(),
                        },
                        cancellation,
                    )
                    .await?;
                    if cancellation.is_cancelled() || answer.is_none() {
                        skipped = true;
                    } else if !matches!(
                        answer,
                        Some(domain::InteractionAnswer::ToolExecution { allow: true })
                    ) {
                        skipped = true;
                        skip_reason = "用户拒绝重复执行此工具";
                    }
                }
                let mut execution_cancelled = false;
                let mut execution_failed = false;
                let mut execution_result_unknown = false;
                let result = if skipped {
                    Err(skip_reason.into())
                } else if namespace.is_some() {
                    Err("工具命名空间未开放".into())
                } else if name == "RequestPermission"
                    && permission_mode != crate::PermissionMode::Interactive
                {
                    Err("当前权限模式不允许申请写入权限".into())
                } else if !exposed.contains(name) {
                    Err(format!("当前会话未开放工具：{name}"))
                } else if let Some(registration) = registered
                    .iter()
                    .find(|tool| tool.declaration.name == *name)
                {
                    let context = crate::tool_execution::ExecutionContext {
                        shared: shared.clone(),
                        host: host.clone(),
                        generation: generation.clone(),
                        request: request.clone(),
                        intent: intent.clone(),
                        cancellation: cancellation.clone(),
                    };
                    match registration
                        .tool
                        .execute(&intent.arguments_json, &context)
                        .await
                    {
                        Ok(output) => Ok(output),
                        Err(crate::ToolError::CommitFailed) => return Err(AgentError::Persistence),
                        Err(crate::ToolError::Cancelled) => {
                            execution_cancelled = true;
                            Err("工具已取消".into())
                        }
                        Err(crate::ToolError::Failed(message)) => Err(message),
                    }
                } else if name == "Command" && cwd.is_some() {
                    let state = shared.lock().unwrap();
                    xw_agent_runtime::tools::command::execute(
                        &state.sessions[&request.session_id].commands,
                        &intent.arguments_json,
                    )
                } else if name == "Skill" && cwd.is_some() {
                    let state = shared.lock().unwrap();
                    crate::skills::execute(
                        &state.sessions[&request.session_id],
                        &intent.arguments_json,
                    )
                } else if name == "TodoWrite" && cwd.is_some() {
                    todos.execute(&intent.arguments_json)
                } else if matches!(name.as_str(), "AskUserQuestion" | "RequestPermission") {
                    match xw_agent_runtime::tools::interactive::parse(name, &intent.arguments_json)
                    {
                        Err(error) => Err(error),
                        Ok(question) => {
                            match crate::interactive::wait(
                                shared,
                                request.session_id,
                                &intent,
                                question.clone(),
                                cancellation,
                            )
                            .await?
                            {
                                Some(answer) => {
                                    grants = shared.lock().unwrap().sessions[&request.session_id]
                                        .granted_paths
                                        .clone();
                                    if let Some(tools) = &tools {
                                        tools.lock().unwrap().set_grants(grants.clone());
                                    }
                                    xw_agent_runtime::tools::interactive::result(&question, &answer)
                                }
                                None => {
                                    execution_cancelled = true;
                                    Err("运行已停止，交互已失效".into())
                                }
                            }
                        }
                    }
                } else if matches!(name.as_str(), "Bash" | "BgRun" | "BgOutput" | "BgStop")
                    && let Some(cwd) = &cwd
                {
                    let cwd = std::path::Path::new(cwd);
                    let arguments = &intent.arguments_json;
                    let outcome = match name.as_str() {
                        "BgRun" => {
                            shells
                                .run(
                                    (request.run_id, intent.tool_id),
                                    cwd,
                                    permission_mode,
                                    &grants,
                                    arguments,
                                    cancellation,
                                )
                                .await
                        }
                        "BgOutput" => shells.output(arguments).await,
                        "BgStop" => shells.stop(arguments).await,
                        _ => {
                            xw_agent_runtime::tools::bash::execute(
                                cwd,
                                permission_mode,
                                &grants,
                                arguments,
                                cancellation.clone(),
                            )
                            .await
                        }
                    };
                    match outcome {
                        Ok(outcome) => {
                            execution_cancelled = outcome.cancelled;
                            execution_failed = outcome.is_error;
                            Ok(outcome.output)
                        }
                        Err(xw_agent_runtime::tools::bash::BashError::NotStarted(error)) => {
                            Err(error)
                        }
                        Err(xw_agent_runtime::tools::bash::BashError::ResultUnknown(cause)) => {
                            log::error!(
                                "Agent {name} outcome unknown run={} tool={}: {cause}",
                                request.run_id,
                                intent.tool_id
                            );
                            execution_result_unknown = true;
                            status = RunStatus::Failed;
                            error = Some(format!("{name} 执行结果未知"));
                            Err(format!("{name} 执行结果未知：{cause}"))
                        }
                    }
                } else if let Some(tools) = &tools {
                    let tools = tools.clone();
                    let name = name.clone();
                    let arguments = intent.arguments_json.clone();
                    let cancellation = cancellation.clone();
                    tokio::task::spawn_blocking(move || {
                        tools
                            .lock()
                            .unwrap()
                            .execute_cancellable(&name, &arguments, &cancellation)
                    })
                    .await
                    .map_err(|_| AgentError::Internal)?
                } else {
                    Err("当前会话未开放工具".into())
                };
                let (tool_status, text, metadata) = match result {
                    Ok(output) => (
                        if execution_cancelled {
                            domain::ToolStatus::Cancelled
                        } else if execution_failed {
                            domain::ToolStatus::Failed
                        } else {
                            domain::ToolStatus::Completed
                        },
                        output.text,
                        output.metadata_json,
                    ),
                    Err(error) => (
                        if execution_result_unknown {
                            domain::ToolStatus::ResultUnknown
                        } else if execution_cancelled {
                            domain::ToolStatus::Cancelled
                        } else if skipped {
                            domain::ToolStatus::Skipped
                        } else if matches!(name.as_str(), "Bash" | "BgRun" | "Glob" | "Grep")
                            && cancellation.is_cancelled()
                        {
                            domain::ToolStatus::Cancelled
                        } else {
                            domain::ToolStatus::Failed
                        },
                        error,
                        None,
                    ),
                };
                if let Err(error) = commit_result(
                    shared,
                    &intent,
                    tool_status,
                    text,
                    metadata,
                    (!skipped).then(|| began.elapsed().as_millis() as u64),
                ) {
                    if name == "BgRun" {
                        shells.cancel_shell(intent.tool_id).await;
                    }
                    return Err(error);
                }
                loaded_skill |= name == "Skill" && tool_status == domain::ToolStatus::Completed;
            }
        }
        if loaded_skill {
            // System updates require all calls from this response to have durable outcomes.
            let mut state = shared.lock().unwrap();
            let session = state.sessions.get_mut(&request.session_id).unwrap();
            crate::tool_registry::synchronize(session, now_ms()?)?;
        }
        if cancellation.is_cancelled() && status != RunStatus::Failed {
            status = RunStatus::Cancelled;
            error = None;
        }
        let history_bytes = {
            let state = shared.lock().unwrap();
            let session = &state.sessions[&request.session_id];
            serde_json::to_vec(&session.history)
                .map_err(|_| AgentError::Internal)?
                .len()
                + session
                    .requests
                    .values()
                    .map(Message::encoded_len)
                    .sum::<usize>()
        };
        if history_bytes > MAX_HISTORY_BYTES {
            status = RunStatus::Failed;
            error = Some("model history budget exceeded".into());
        }
        let more = calls > 0 && status == RunStatus::Completed;
        settle_turn(
            shared,
            request,
            status,
            error.as_deref(),
            turn_started.elapsed().as_millis() as u64,
        )?;
        if !more {
            settle_run(
                shared,
                request,
                &mut status,
                error.as_deref(),
                started.elapsed().as_millis() as u64,
                used,
            )?;
            return Ok((status, error));
        }
        let result = crate::compaction::compact_if_needed(
            shared,
            request,
            model,
            &[],
            sample,
            request.turn_id,
            generation.clone(),
            cancellation,
        )
        .await?;
        if cancellation.is_cancelled() || result.is_err() {
            return settle_preflight(shared, request, cancellation, result, started, used);
        }
        ordinal += 1;
        request.turn_id = Some(domain::TurnId::new());
        request.gen_id = domain::GenId::new();
        request.message_id = domain::MessageId::new();
        let result = start_next(
            shared,
            request,
            ordinal,
            &model.budget,
            *sample,
            cancellation,
        )?;
        if result != Ok(true) {
            return settle_preflight(
                shared,
                request,
                cancellation,
                result.map(|_| ()),
                started,
                used,
            );
        }
    }
}

fn commit_intent(shared: &Mutex<State>, intent: &domain::ToolIntent) -> Result<(), AgentError> {
    let mut state = shared.lock().unwrap();
    let session_id = state
        .sessions
        .iter()
        .find(|(_, s)| {
            s.active
                .as_ref()
                .is_some_and(|r| r.run_id == intent.key.run_id)
        })
        .map(|(id, _)| *id)
        .ok_or(AgentError::Internal)?;
    let session = state.sessions.get_mut(&session_id).unwrap();
    session.append(domain::EntryPayload::ToolIntent(intent.clone()), now_ms()?)?;
    let item = tool_item(intent, None);
    session
        .view
        .runs
        .last_mut()
        .unwrap()
        .items
        .push(item.clone());
    AgentService::publish(
        &mut state,
        event(agent_event::Payload::ItemStarted(ItemStarted {
            session_id: session_id.to_string(),
            run_id: intent.key.run_id.to_string(),
            item: Some(item),
        })),
    );
    log::debug!(
        "Agent tool started session={session_id} run={} tool={} name={}",
        intent.key.run_id,
        intent.tool_id,
        intent.tool_name
    );
    Ok(())
}

fn commit_result(
    shared: &Mutex<State>,
    intent: &domain::ToolIntent,
    status: domain::ToolStatus,
    text: String,
    metadata_json: Option<String>,
    duration_ms: Option<u64>,
) -> Result<(), AgentError> {
    let at = now_ms()?;
    let outcome = tool_outcome(intent, status, text, metadata_json, duration_ms, at);
    let mut state = shared.lock().unwrap();
    let (session_id, session) = state
        .sessions
        .iter_mut()
        .find(|(_, s)| {
            s.active
                .as_ref()
                .is_some_and(|r| r.run_id == intent.key.run_id)
        })
        .ok_or(AgentError::Internal)?;
    let session_id = *session_id;
    session.append(domain::EntryPayload::ToolOutcome(outcome.clone()), at)?;
    session.history.push(outcome.result.message.clone());
    if intent.tool_name == "Skill" && status == domain::ToolStatus::Completed {
        crate::skills::activate(session, &intent.arguments_json)?;
    }
    let mut item = tool_item(intent, Some(&outcome));
    if let Some(agent_item::Content::ToolCall(tool)) = &mut item.content {
        tool.interaction = session
            .interactions
            .values()
            .find(|record| record.opened.tool_id == intent.tool_id)
            .map(|record| record.view());
    }
    let current = session
        .view
        .runs
        .last_mut()
        .unwrap()
        .items
        .iter_mut()
        .find(|item| item.item_id == intent.block_id.to_string())
        .ok_or(AgentError::Internal)?;
    *current = item.clone();
    AgentService::publish(
        &mut state,
        event(agent_event::Payload::ItemCompleted(ItemCompleted {
            session_id: session_id.to_string(),
            run_id: intent.key.run_id.to_string(),
            item: Some(item),
        })),
    );
    log::debug!(
        "Agent tool settled session={session_id} tool={} name={} \
         status={status:?} duration_ms={duration_ms:?}",
        intent.tool_id,
        intent.tool_name
    );
    Ok(())
}

pub(crate) fn tool_outcome(
    intent: &domain::ToolIntent,
    status: domain::ToolStatus,
    text: String,
    metadata_json: Option<String>,
    duration_ms: Option<u64>,
    at: i64,
) -> domain::ToolOutcome {
    let error = (status == domain::ToolStatus::ResultUnknown).then(|| domain::SafeError {
        code: "tool_result_unknown".into(),
        message: text.clone(),
    });
    domain::ToolOutcome {
        tool_id: intent.tool_id,
        key: intent.key.clone(),
        status,
        result: domain::RecordedMessage {
            message_id: domain::MessageId::new(),
            block_ids: vec![domain::BlockId::new()],
            run_id: Some(intent.key.run_id),
            turn_id: Some(intent.key.turn_id),
            gen_id: Some(intent.key.gen_id),
            input_id: None,
            completeness: domain::MessageCompleteness::Complete,
            message: domain::AgentMessage::ToolResult(domain::ToolResultMessage {
                tool_call_id: intent.key.provider_call_id.clone(),
                tool_name: intent.tool_name.clone(),
                content: vec![domain::ContentBlock::Text {
                    text,
                    signature: None,
                }],
                is_error: status != domain::ToolStatus::Completed,
                timestamp_ms: at,
                details_json: None,
                added_tool_names: vec![],
                usage: None,
            }),
        },
        metadata_json,
        duration_ms,
        elapsed_ms: duration_ms,
        queue_duration_ms: None,
        error,
        settled_by_run_id: None,
    }
}

pub(crate) fn tool_item(
    intent: &domain::ToolIntent,
    outcome: Option<&domain::ToolOutcome>,
) -> AgentItem {
    let status = outcome
        .map_or(AgentToolStatus::Pending, |o| match o.status {
            domain::ToolStatus::Completed => AgentToolStatus::Completed,
            domain::ToolStatus::Failed => AgentToolStatus::Failed,
            domain::ToolStatus::Cancelled => AgentToolStatus::Cancelled,
            domain::ToolStatus::Skipped => AgentToolStatus::Skipped,
            domain::ToolStatus::ResultUnknown => AgentToolStatus::ResultUnknown,
        })
        .into();
    let output = outcome
        .and_then(|o| match &o.result.message {
            domain::AgentMessage::ToolResult(result) => Some(
                result
                    .content
                    .iter()
                    .filter_map(|b| {
                        if let domain::ContentBlock::Text { text, .. } = b {
                            Some(text.as_str())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => None,
        })
        .unwrap_or_default();
    AgentItem {
        item_id: intent.block_id.to_string(),
        gen_id: Some(intent.key.gen_id.to_string()),
        content: Some(agent_item::Content::ToolCall(AgentToolCall {
            tool_id: intent.tool_id.to_string(),
            turn_id: intent.key.turn_id.to_string(),
            gen_id: intent.key.gen_id.to_string(),
            provider_call_id: intent.key.provider_call_id.clone(),
            name: intent.tool_name.clone(),
            arguments_json: intent.arguments_json.clone(),
            status,
            output,
            metadata_json: outcome.and_then(|o| o.metadata_json.clone()),
            duration_ms: outcome.and_then(|o| o.duration_ms),
            interaction: None,
        })),
        ..Default::default()
    }
}

fn failure(error: Option<&str>) -> Option<domain::SafeError> {
    error.map(|message| {
        crate::compaction::public_error(message).unwrap_or_else(|| domain::SafeError {
            code: "run_failed".into(),
            message: "运行失败，请检查工具结果或模型配置后重试".into(),
        })
    })
}

fn settle_preflight(
    shared: &Mutex<State>,
    request: &RunRequest,
    cancellation: &CancellationToken,
    result: Result<(), &'static str>,
    started: Instant,
    used: u32,
) -> Result<(RunStatus, Option<String>), AgentError> {
    let (mut status, error) = if cancellation.is_cancelled() {
        (RunStatus::Cancelled, None)
    } else {
        (RunStatus::Failed, result.err().map(str::to_owned))
    };
    settle_run(
        shared,
        request,
        &mut status,
        error.as_deref(),
        started.elapsed().as_millis() as u64,
        used,
    )?;
    Ok((status, error))
}

fn settle_turn(
    shared: &Mutex<State>,
    request: &RunRequest,
    status: RunStatus,
    error: Option<&str>,
    elapsed: u64,
) -> Result<(), AgentError> {
    let mut state = shared.lock().unwrap();
    state
        .sessions
        .get_mut(&request.session_id)
        .unwrap()
        .append(
            domain::EntryPayload::TurnEnded(domain::TurnEnded {
                turn_id: request.turn_id.expect("conversation Turn"),
                status: match status {
                    RunStatus::Completed => domain::TurnStatus::Completed,
                    RunStatus::Failed => domain::TurnStatus::Failed,
                    RunStatus::Cancelled => domain::TurnStatus::Aborted,
                },
                final_gen_id: Some(request.gen_id),
                duration_ms: Some(elapsed),
                error: failure(error),
            }),
            now_ms()?,
        )?;
    Ok(())
}

fn settle_run(
    shared: &Mutex<State>,
    request: &RunRequest,
    status: &mut RunStatus,
    error: Option<&str>,
    elapsed: u64,
    used: u32,
) -> Result<(), AgentError> {
    let mut state = shared.lock().unwrap();
    let session = state.sessions.get_mut(&request.session_id).unwrap();
    if session
        .active
        .as_ref()
        .is_some_and(|active| active.cancellation.is_cancelled())
        && *status == RunStatus::Completed
    {
        *status = RunStatus::Cancelled;
    }
    for position in 0..session.queue.len() {
        let input = &session.queue[position];
        let targets_run = input.target == Some(request.run_id);
        let unconsumed_interrupt = session.dispatching == Some(input.accepted.input_id)
            && input.mode == domain::InputMode::Interrupt;
        if (targets_run
            && (input.mode == domain::InputMode::Steering
                || (*status == RunStatus::Failed && input.mode == domain::InputMode::Interrupt)))
            || unconsumed_interrupt
        {
            let input_id = session.queue[position].accepted.input_id;
            session.append(
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
    }
    let had_assistant_output = session.view.runs.last().unwrap().items.iter().any(|item| {
        matches!(
            item.content,
            Some(agent_item::Content::AgentMessage(_))
                | Some(agent_item::Content::Reasoning(_))
                | Some(agent_item::Content::ToolCall(_))
        )
    });
    session.append(
        domain::EntryPayload::RunEnd(domain::RunEnd {
            run_id: request.run_id,
            status: match *status {
                RunStatus::Completed => domain::RunStatus::Completed,
                RunStatus::Failed => domain::RunStatus::Failed,
                RunStatus::Cancelled => domain::RunStatus::Aborted,
            },
            duration_ms: Some(elapsed),
            error: failure(error),
            had_assistant_output,
            tool_calls_used: used,
            context_tokens: None,
        }),
        now_ms()?,
    )?;
    session.active.as_mut().expect("active Run").committed = true;
    crate::queue::publish(&mut state, request.session_id);
    Ok(())
}

fn start_next(
    shared: &Mutex<State>,
    request: &mut RunRequest,
    ordinal: u32,
    model_budget: &domain::ModelBudget,
    sample: Option<ContextSample>,
    cancellation: &CancellationToken,
) -> Result<Result<bool, &'static str>, AgentError> {
    let mut state = shared.lock().unwrap();
    if cancellation.is_cancelled() {
        return Ok(Ok(false));
    }
    let session = state.sessions.get_mut(&request.session_id).unwrap();
    let upcoming =
        crate::queue::steering_input(session, request.run_id).map(|input| &input.message.message);
    let budget = ContextBudget::new(
        model_budget,
        sample,
        &session.history,
        upcoming.map_or(&[], std::slice::from_ref),
    );
    if budget.projected > budget.hard_limit {
        return Ok(Err(crate::compaction::INPUT_LIMIT));
    }
    let at = now_ms()?;
    let mut boundary = session.boundary(None);
    session.append(
        domain::EntryPayload::TurnStarted(domain::TurnStarted {
            turn_id: request.turn_id.expect("conversation Turn"),
            run_id: request.run_id,
            ordinal,
            boundary: boundary.clone(),
        }),
        at,
    )?;
    let mut inserted = None;
    if let Some(position) = session.queue.iter().position(|input| {
        input.mode == domain::InputMode::Steering && input.target == Some(request.run_id)
    }) {
        let input = session.queue[position].clone();
        let consumed = session.append(
            domain::EntryPayload::InputConsumed(domain::InputConsumed {
                input_ids: vec![input.accepted.input_id],
                run_id: request.run_id,
                turn_id: request.turn_id.expect("conversation Turn"),
                boundary: boundary.clone(),
            }),
            at,
        )?;
        if let Some(consumed) = consumed {
            boundary.through_entry_id = Some(consumed.entry_id);
        }
        session.history.push(input.message.message.clone());
        let item = AgentItem {
            item_id: input.message.block_ids[0].to_string(),
            gen_id: None,
            content: Some(agent_item::Content::UserMessage(AgentUserMessage {
                content: input.view().input,
                input_id: Some(input.accepted.input_id.to_string()),
            })),
            ..Default::default()
        };
        session
            .view
            .runs
            .last_mut()
            .expect("active Run")
            .items
            .push(item.clone());
        session.queue.remove(position);
        inserted = Some(item);
    }
    session.append(
        domain::EntryPayload::GenStarted(domain::GenStarted {
            gen_id: request.gen_id,
            run_id: Some(request.run_id),
            turn_id: request.turn_id,
            attempt: 1,
            purpose: domain::GenPurpose::Conversation,
            context: None,
            boundary,
            started_at_ms: at,
        }),
        at,
    )?;
    request.generation.messages = session.history.clone();
    let update = opening_generation(session, request, at);
    if let Some(item) = inserted {
        AgentService::publish(
            &mut state,
            event(agent_event::Payload::ItemCompleted(ItemCompleted {
                session_id: request.session_id.to_string(),
                run_id: request.run_id.to_string(),
                item: Some(item),
            })),
        );
        crate::queue::publish(&mut state, request.session_id);
    }
    AgentService::publish(&mut state, event(update));
    Ok(Ok(true))
}

fn opening_generation(
    session: &mut crate::session::Session,
    request: &RunRequest,
    at: i64,
) -> agent_event::Payload {
    let run = session.view.runs.last_mut().expect("active Run");
    run.generation = Some(AgentGeneration {
        gen_id: request.gen_id.to_string(),
        started_at_ms: at,
        ..Default::default()
    });
    generation_update(request.session_id, run)
}
