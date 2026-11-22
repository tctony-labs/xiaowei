use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::sync::oneshot;
use xw_agent_runtime::{GenerationRequest, complete_text};
use xw_agent_types::{
    AgentMessage as ModelMessage, ContentBlock, EntryPayload, GenId, RunId, SessionId,
    TitleGenerated, UserMessage,
};

use crate::{
    AgentError, AgentHost, AgentService, CancellationToken, LlmGeneration,
    protocol::*,
    service::{State, now_ms},
    session::{Session, TitleTask, parse_id},
};

const SYSTEM_PROMPT: &str = "你是会话标题生成器。根据下方对话历史生成一个 6-15 字的简洁中文标题，\
概括整段对话的核心主题。仅输出标题本身，不要带引号、句号、emoji 或任何解释。";
const TITLE_HISTORY_PAGE_RUNS: usize = 50;

impl AgentService {
    pub(crate) fn set_title_loaded(
        &self,
        request: SetSessionTitleRequest,
    ) -> Result<SetSessionTitleResponse, AgentError> {
        let id: SessionId = parse_id(&request.session_id, "session_id")?;
        let title = request.title.trim();
        if title.is_empty() || title.chars().count() > 50 || title.chars().any(char::is_control) {
            return Err(AgentError::InvalidArgument("title"));
        }
        let mut state = self.state()?;
        let session = state
            .sessions
            .get_mut(&id)
            .filter(|session| !session.deleted())
            .ok_or(AgentError::NotFound("session"))?;
        if session.view.title == title
            && !session.view.auto_title_enabled
            && session.current_title_task.is_none()
        {
            return Ok(SetSessionTitleResponse {
                title: session.view.title.clone(),
                metadata_revision: session.view.metadata_revision,
            });
        }

        session.prepare_writer()?;
        let previous_view = session.view.clone();
        session.cancel_titles();
        session.view.title = title.to_owned();
        session.view.auto_title_enabled = false;
        session.view.metadata_revision += 1;
        session.view.updated_at_ms = session.view.updated_at_ms.max(now_ms()?);
        let view = session.view.clone();
        if let Err(error) = session.commit_meta(&view) {
            session.view = previous_view;
            return Err(error);
        }
        let response = SetSessionTitleResponse {
            title: session.view.title.clone(),
            metadata_revision: session.view.metadata_revision,
        };
        let update = SessionTitleUpdated {
            session_id: id.to_string(),
            title: response.title.clone(),
            metadata_revision: response.metadata_revision,
            title_model_ref: session.view.title_model_ref.clone(),
            auto_title_enabled: false,
            updated_at_ms: session.view.updated_at_ms,
        };
        Self::publish(
            &mut state,
            AgentEvent {
                emitted_at_ms: now_ms()?,
                payload: Some(agent_event::Payload::SessionTitleUpdated(update)),
            },
        );
        log::debug!(
            "Agent manual title set session={id} revision={}",
            response.metadata_revision
        );
        Ok(response)
    }

    pub(crate) async fn regenerate_loaded(
        &self,
        request: RegenerateTitleRequest,
    ) -> Result<RegenerateTitleResponse, AgentError> {
        let id: SessionId = parse_id(&request.session_id, "session_id")?;
        let result = {
            let mut state = self.state()?;
            let session = state
                .sessions
                .get(&id)
                .filter(|s| !s.deleted())
                .ok_or(AgentError::NotFound("session"))?;
            if session.active.is_some() {
                return Err(AgentError::Conflict("session is running"));
            }
            schedule_title(
                &mut state,
                self.state.clone(),
                self.host.clone(),
                self.index.clone(),
                id,
                true,
            )?
        };
        result.await.map_err(|_| AgentError::Internal)?
    }
}

/// Register the task under the same lock as run settlement / manual requests.
/// Superseded tasks stay tracked until their cancellation has settled.
pub(crate) fn schedule_title(
    state: &mut State,
    shared: Arc<Mutex<State>>,
    host: Arc<dyn AgentHost>,
    index: Option<Arc<crate::index::IndexAccess>>,
    id: SessionId,
    update_activity: bool,
) -> Result<oneshot::Receiver<Result<RegenerateTitleResponse, AgentError>>, AgentError> {
    if state.closed {
        return Err(AgentError::Closed);
    }
    let session = state
        .sessions
        .get_mut(&id)
        .filter(|s| !s.deleted())
        .ok_or(AgentError::NotFound("session"))?;
    let generation: Arc<dyn LlmGeneration> = Arc::new(crate::host::HostGeneration(host.clone()));
    session.available()?;
    let prompt = build_prompt(&session.view.runs);
    if prompt.is_empty() {
        return Err(AgentError::TitleGeneration("没有可用于生成标题的对话轮次"));
    }
    if session.title_tasks.len() >= 16 {
        return Err(AgentError::ResourceExhausted("title tasks"));
    }
    let handle =
        tokio::runtime::Handle::try_current().map_err(|_| AgentError::ExecutionUnavailable)?;
    session.cancel_titles();
    let task_id = GenId::new();
    let revision = session.view.metadata_revision;
    let cancellation = CancellationToken::new();
    let done = CancellationToken::new();
    session.current_title_task = Some(task_id);
    session.title_tasks.insert(
        task_id,
        TitleTask {
            cancellation: cancellation.clone(),
            done: done.clone(),
        },
    );
    let (tx, rx) = oneshot::channel();
    handle.spawn(async move {
        let _done = done.drop_guard();
        let task = async {
            let model_ref = host
                .get_auxiliary_model_ref()
                .await
                .map_err(|_| AgentError::TitleGeneration("辅助模型配置获取失败"))?
                .ok_or(AgentError::TitleGeneration(
                    "尚未配置小文本任务模型，请先在设置中选择",
                ))?;
            if model_ref.trim().is_empty() || model_ref.len() > 1024 {
                return Err(AgentError::TitleGeneration("辅助模型引用无效"));
            }
            let request = GenerationRequest {
                session_id: id,
                model_ref: model_ref.clone(),
                system_prompt: SYSTEM_PROMPT.into(),
                messages: vec![ModelMessage::User(UserMessage {
                    content: vec![ContentBlock::Text {
                        text: prompt,
                        signature: None,
                    }],
                    timestamp_ms: now_ms().unwrap_or_default(),
                })],
                reasoning: Some("off".into()),
                temperature: Some(0.8),
                max_tokens: Some(64),
            };
            complete_text(request, generation, cancellation.clone())
                .await
                .map_err(|_| AgentError::TitleGeneration("标题生成失败，请稍后重试"))
        };
        let future = task;
        tokio::pin!(future);
        let result = tokio::select! {
            result = &mut future => result,
            _ = tokio::time::sleep(Duration::from_secs(20)) => {
                cancellation.cancel();
                let _ = future.await;
                Err(AgentError::TitleGeneration("标题生成超时，请重试"))
            }
        }
        .and_then(|message| {
            let text = message
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            let title = clean_title(&text);
            if title.is_empty() {
                return Err(AgentError::TitleGeneration("模型返回空标题，请重试"));
            }
            Ok(title)
        });

        if let Some(index) = index {
            let _gate = index.gate.lock().await;
            let result = match result {
                Ok(title) => crate::index::persist_title(
                    &shared,
                    &index,
                    id,
                    crate::index::TitleUpdate {
                        title,
                        auto_title_enabled: true,
                        update_activity,
                        expected: Some((task_id, revision)),
                    },
                )
                .await
                .map(|r| RegenerateTitleResponse {
                    title: r.title,
                    metadata_revision: r.metadata_revision,
                }),
                Err(error) => Err(error),
            };
            if let Ok(mut state) = shared.lock()
                && let Some(session) = state.sessions.get_mut(&id)
            {
                session.title_tasks.remove(&task_id);
                if session.current_title_task == Some(task_id) {
                    session.current_title_task = None;
                }
            }
            if let Err(error) = &result {
                log::debug!("Agent title not updated session={id} task={task_id} reason={error}");
            }
            let _ = tx.send(result);
            return;
        }

        let mut state = shared.lock().unwrap();
        let closed = state.closed;
        let result = if let Some(session) = state.sessions.get_mut(&id) {
            session.title_tasks.remove(&task_id);
            if closed
                || session.deleted()
                || session.current_title_task != Some(task_id)
                || session.view.metadata_revision != revision
            {
                Err(AgentError::Conflict("title task superseded"))
            } else {
                session.current_title_task = None;
                result.and_then(|title| {
                    let previous_view = session.view.clone();
                    session.view.title = title.clone();
                    session.view.auto_title_enabled = true;
                    session.view.title_model_ref.clear();
                    session.view.metadata_revision += 1;
                    if update_activity {
                        session.view.updated_at_ms = session.view.updated_at_ms.max(now_ms()?);
                    }
                    let view = session.view.clone();
                    if let Err(error) = session.commit_meta(&view) {
                        session.view = previous_view;
                        return Err(error);
                    }
                    session.last_unjournaled_title = title_generation(&session.view.runs);
                    Ok(RegenerateTitleResponse {
                        title,
                        metadata_revision: session.view.metadata_revision,
                    })
                })
            }
        } else {
            Err(AgentError::NotFound("session"))
        };
        match &result {
            Ok(response) => {
                let updated_at_ms = state.sessions[&id].view.updated_at_ms;
                AgentService::publish(
                    &mut state,
                    AgentEvent {
                        emitted_at_ms: now_ms().unwrap_or_default(),
                        payload: Some(agent_event::Payload::SessionTitleUpdated(
                            SessionTitleUpdated {
                                session_id: id.to_string(),
                                title: response.title.clone(),
                                metadata_revision: response.metadata_revision,
                                title_model_ref: String::new(),
                                auto_title_enabled: true,
                                updated_at_ms,
                            },
                        )),
                    },
                );
                log::debug!("Agent title updated session={id} task={task_id}");
            }
            Err(error) => {
                log::debug!("Agent title not updated session={id} task={task_id} reason={error}")
            }
        }
        let _ = tx.send(result);
    });
    Ok(rx)
}

pub(crate) fn has_output(run: &AgentRun) -> bool {
    run.items.iter().any(|item| match &item.content {
        Some(agent_item::Content::AgentMessage(message)) => !message.text.is_empty(),
        Some(agent_item::Content::Reasoning(reasoning)) => !reasoning.text.is_empty(),
        _ => false,
    })
}

fn is_title_round(run: &AgentRun) -> bool {
    run.status != i32::from(AgentRunStatus::InProgress) && has_output(run)
}

pub(crate) fn title_generation(runs: &[AgentRun]) -> Option<TitleGenerated> {
    let mut rounds = runs.iter().filter(|run| is_title_round(run));
    let run_id = rounds.next_back()?.run_id.parse().ok()?;
    Some(TitleGenerated {
        run_id,
        round: rounds.count() as u32 + 1,
    })
}

pub(crate) fn last_title_in_recent_page(session: &Session) -> Option<&TitleGenerated> {
    let runs = &session.view.runs;
    let page = &runs[runs.len().saturating_sub(TITLE_HISTORY_PAGE_RUNS)..];
    let first_run_id = page.first()?.run_id.parse::<RunId>().ok()?;
    let in_page = |title: &TitleGenerated| {
        let run_id = title.run_id.to_string();
        page.iter().any(|run| run.run_id == run_id)
    };
    if let Some(journal) = &session.journal {
        let recent = journal.entries().iter().rev().take_while(|entry| {
            !matches!(&entry.payload, EntryPayload::RunStarted(run) if run.run_id == first_run_id)
        });
        for entry in recent {
            if let EntryPayload::TitleGenerated(title) = &entry.payload
                && in_page(title)
            {
                return Some(title);
            }
        }
    }
    session
        .last_unjournaled_title
        .as_ref()
        .filter(|title| in_page(title))
}

fn build_prompt(runs: &[AgentRun]) -> String {
    let mut rounds = Vec::new();
    for run in runs.iter().rev() {
        if !is_title_round(run) {
            continue;
        }
        let user = run
            .items
            .iter()
            .filter_map(|item| match &item.content {
                Some(agent_item::Content::UserMessage(message)) => Some(
                    message
                        .content
                        .iter()
                        .filter_map(|input| match &input.content {
                            Some(agent_user_input::Content::Text(text)) => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n"),
                ),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");

        let last_text_gen = run.items.iter().rev().find_map(|item| match &item.content {
            Some(agent_item::Content::AgentMessage(message)) if !message.text.is_empty() => {
                item.gen_id.as_deref()
            }
            _ => None,
        });
        let assistant = last_text_gen.map_or_else(String::new, |gen_id| {
            run.items
                .iter()
                .filter(|item| item.gen_id.as_deref() == Some(gen_id))
                .filter_map(|item| match &item.content {
                    Some(agent_item::Content::AgentMessage(message)) => Some(message.text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n")
        });

        rounds.push((user, assistant));
        if rounds.len() == 5 {
            break;
        }
    }
    if rounds.is_empty() {
        return String::new();
    }
    let mut prompt = String::from("对话历史:\n");
    for (index, (user, assistant)) in rounds.iter().rev().enumerate() {
        let user = user.trim().chars().take(600).collect::<String>();
        let assistant = assistant.trim().chars().take(600).collect::<String>();
        prompt.push_str(&format!(
            "\n[第{}轮]\n用户: {user}\n助手: {assistant}\n",
            index + 1
        ));
    }
    prompt.push_str("\n请输出标题:");
    prompt
}

fn clean_title(raw: &str) -> String {
    let mut title = raw.trim();
    while let Some(stripped) = title
        .strip_prefix(['"', '\'', '“', '”', '「', '『', '《'])
        .or_else(|| title.strip_prefix("**"))
    {
        title = stripped.trim();
    }
    while let Some(stripped) = title
        .strip_suffix(['"', '\'', '“', '”', '」', '』', '》', '。', '.'])
        .or_else(|| title.strip_suffix("**"))
    {
        title = stripped.trim();
    }
    title.replace('\n', " ").trim().chars().take(50).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_outside_the_latest_run_page_does_not_set_the_cadence() {
        let mut session = Session::new(SessionId::new(), 1, AgentModelConfig::default());
        session.view.runs = (0..=TITLE_HISTORY_PAGE_RUNS)
            .map(|_| AgentRun {
                run_id: RunId::new().to_string(),
                ..Default::default()
            })
            .collect();
        session.last_unjournaled_title = Some(TitleGenerated {
            run_id: session.view.runs[0].run_id.parse().unwrap(),
            round: 1,
        });
        assert!(last_title_in_recent_page(&session).is_none());

        session.view.runs.pop();
        assert_eq!(last_title_in_recent_page(&session).unwrap().round, 1);
    }

    #[test]
    fn title_prompt_keeps_last_five_rounds_and_last_assistant_message() {
        let runs = (1..=6)
            .map(|n| AgentRun {
                status: AgentRunStatus::Completed.into(),
                items: vec![
                    AgentItem {
                        content: Some(agent_item::Content::UserMessage(AgentUserMessage {
                            content: vec![AgentUserInput {
                                content: Some(agent_user_input::Content::Text(format!("q{n}"))),
                            }],
                        })),
                        ..Default::default()
                    },
                    AgentItem {
                        content: Some(agent_item::Content::Reasoning(AgentReasoning {
                            text: "private reasoning".into(),
                        })),
                        ..Default::default()
                    },
                    AgentItem {
                        gen_id: Some("intermediate".into()),
                        content: Some(agent_item::Content::AgentMessage(AgentMessage {
                            text: "intermediate text".into(),
                        })),
                        ..Default::default()
                    },
                    AgentItem {
                        gen_id: Some("last".into()),
                        content: Some(agent_item::Content::AgentMessage(AgentMessage {
                            text: "final text".into(),
                        })),
                        ..Default::default()
                    },
                    AgentItem {
                        gen_id: Some("last".into()),
                        content: Some(agent_item::Content::AgentMessage(AgentMessage {
                            text: "答".repeat(700),
                        })),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            })
            .collect::<Vec<_>>();
        let prompt = build_prompt(&runs);
        assert!(!prompt.contains("q1"));
        assert!(prompt.find("q2").unwrap() < prompt.find("q6").unwrap());
        assert!(!prompt.contains("intermediate text"));
        assert!(!prompt.contains("private reasoning"));
        assert_eq!(prompt.matches("final text").count(), 5);
        assert_eq!(
            prompt.matches('答').count(),
            5 * (600 - "final text\n".len())
        );
        assert_eq!(
            clean_title(&format!("**{}。**", "题".repeat(80)))
                .chars()
                .count(),
            50
        );
    }
}
