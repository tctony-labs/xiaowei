use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tokio::sync::mpsc;
use xw_agent_runtime::{RunRequest, RunStatus, execute_text};
use xw_agent_types as domain;

use crate::{
    AgentHost, CancellationToken, GenerationEvent, GenerationRequest, LlmGeneration, ToolContext,
    ToolError, ToolFuture,
    service::{State, now_ms},
};

pub(crate) struct ExecutionContext {
    pub shared: Arc<Mutex<State>>,
    pub host: Arc<dyn AgentHost>,
    pub generation: Arc<dyn LlmGeneration>,
    pub request: RunRequest,
    pub intent: domain::ToolIntent,
    pub cancellation: CancellationToken,
}

impl ToolContext for ExecutionContext {
    fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    fn extract_text(&self, content: String, prompt: String) -> ToolFuture<'_, String> {
        Box::pin(async move {
            let cancel = self.cancellation.child_token();
            let deadline = tokio::time::sleep(Duration::from_secs(60));
            tokio::pin!(deadline);
            let configuration = async {
                let model_ref = self
                    .host
                    .get_auxiliary_model_ref()
                    .await
                    .map_err(|_| ToolError::Failed("无法读取辅助模型配置".into()))?
                    .filter(|value| !value.trim().is_empty() && value.len() <= 1024)
                    .ok_or_else(|| ToolError::Failed("请先在设置中配置小文本任务模型".into()))?;
                let info = self
                    .host
                    .get_model_info(model_ref.clone())
                    .await
                    .and_then(|info| crate::model::validate_info(&model_ref, info))
                    .map_err(|_| ToolError::Failed("小文本任务模型不可用".into()))?;
                Ok::<_, ToolError>((model_ref, info))
            };
            let (model_ref, info) = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(ToolError::Cancelled),
                _ = &mut deadline => return Err(ToolError::Failed("辅助模型配置读取超时".into())),
                result = configuration => result?,
            };
            let at = now_ms().map_err(|_| ToolError::CommitFailed)?;
            let request = RunRequest {
                session_id: self.request.session_id,
                input_id: self.request.input_id,
                run_id: self.request.run_id,
                turn_id: None,
                gen_id: domain::GenId::new(),
                message_id: domain::MessageId::new(),
                generation: GenerationRequest {
                    session_id: self.request.session_id,
                    model_ref: model_ref.clone(),
                    reasoning: info.capabilities.supports_reasoning.then(|| "off".into()),
                    temperature: Some(0.3),
                    max_tokens: Some(info.capabilities.max_output_tokens.min(2048) as u32),
                    system_prompt: "你是网页内容提取助手。根据提供的网页内容和用户的提取指令，\
                        生成简明准确的回复。引用页面原文时使用引号；\
                        超出内容范围的问题如实说明无法回答。"
                        .into(),
                    messages: vec![domain::AgentMessage::User(domain::UserMessage {
                        timestamp_ms: at,
                        content: vec![domain::ContentBlock::Text {
                            text: format!(
                                "Web page content:\n---\n{content}\n---\n\n{prompt}\n\n\
                                 提供简明回复，包含必要的细节、代码示例和文档片段。"
                            ),
                            signature: None,
                        }],
                    })],
                },
            };
            let context = domain::RunContext {
                model: domain::ModelDescriptor {
                    model_ref,
                    provider_name: Some(info.provider_name),
                    model_name: Some(info.model_name),
                    budget: domain::ModelBudget {
                        context_window: info.capabilities.context_window,
                        max_output_tokens: info.capabilities.max_output_tokens,
                        source: domain::BudgetSource::Host,
                    },
                    capabilities: Some(info.capabilities),
                },
                generation: domain::GenerationParameters {
                    reasoning: request.generation.reasoning.clone(),
                    temperature: request.generation.temperature,
                    max_tokens: request.generation.max_tokens,
                    timeout_ms: Some(60_000),
                    ..Default::default()
                },
                tools: vec![],
                limits: domain::RuntimeLimits {
                    max_gens: Some(1),
                    max_tool_calls: 0,
                },
            };
            self.commit(
                domain::EntryPayload::GenStarted(domain::GenStarted {
                    gen_id: request.gen_id,
                    run_id: Some(request.run_id),
                    turn_id: None,
                    attempt: 1,
                    purpose: domain::GenPurpose::ToolExtraction {
                        tool_id: self.intent.tool_id,
                    },
                    context: Some(context),
                    boundary: self.boundary()?,
                    started_at_ms: at,
                }),
                at,
            )?;

            let started = Instant::now();
            let (tx, mut rx) = mpsc::channel(32);
            let future = execute_text(request.clone(), self.generation.clone(), cancel.clone(), tx);
            tokio::pin!(future);
            let mut commit_failed = false;
            let mut first_sse_committed = false;
            let mut timed_out = false;
            let mut outcome = loop {
                tokio::select! {
                    biased;
                    Some(update) = rx.recv() => {
                        if commit_failed { continue; }
                        if let GenerationEvent::FirstSseReceived { received_at_ms } = update.event {
                            if self.commit(domain::EntryPayload::GenFirstSseReceived(
                                domain::GenFirstSseReceived {
                                    gen_id: request.gen_id, received_at_ms
                                }
                            ), received_at_ms).is_err() {
                                commit_failed = true;
                                cancel.cancel();
                            } else {
                                first_sse_committed = true;
                            }
                        }
                    }
                    outcome = &mut future => break outcome,
                    _ = &mut deadline, if !timed_out => {
                        timed_out = true;
                        cancel.cancel();
                    }
                }
            };
            if commit_failed {
                return Err(ToolError::CommitFailed);
            }
            // A short, ready stream may finish in the same poll that fills the channel.
            if !first_sse_committed && let Some(received_at_ms) = outcome.first_sse_at_ms {
                self.commit(
                    domain::EntryPayload::GenFirstSseReceived(domain::GenFirstSseReceived {
                        gen_id: request.gen_id,
                        received_at_ms,
                    }),
                    received_at_ms,
                )?;
            }
            if outcome
                .message
                .as_ref()
                .is_some_and(|message| message.stop_reason == domain::FinishReason::ToolUse)
            {
                outcome.status = RunStatus::Failed;
                outcome.error = Some(crate::GenerationError::Failed(
                    "tool extraction cannot call tools".into(),
                ));
            }
            {
                let mut state = self.shared.lock().map_err(|_| ToolError::CommitFailed)?;
                let session = state
                    .sessions
                    .get_mut(&request.session_id)
                    .ok_or(ToolError::CommitFailed)?;
                session
                    .record_generation(&request, &outcome, &Default::default())
                    .map_err(|_| ToolError::CommitFailed)?;
            }
            log::debug!(
                "Agent tool extraction settled tool={} gen={} status={:?} duration_ms={}",
                self.intent.tool_id,
                request.gen_id,
                outcome.status,
                started.elapsed().as_millis()
            );
            if self.cancellation.is_cancelled() {
                return Err(ToolError::Cancelled);
            }
            if timed_out {
                return Err(ToolError::Failed("辅助模型提取超时".into()));
            }
            if outcome.status != RunStatus::Completed {
                return Err(ToolError::Failed(
                    "辅助模型提取失败，请检查小文本任务模型".into(),
                ));
            }
            let message = outcome.message.expect("completed generation");
            if !matches!(
                message.stop_reason,
                domain::FinishReason::Stop | domain::FinishReason::Length
            ) {
                return Err(ToolError::Failed("辅助模型返回了不支持的工具调用".into()));
            }
            let text = message
                .content
                .iter()
                .filter_map(|block| match block {
                    domain::ContentBlock::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            if text.trim().is_empty() {
                return Err(ToolError::Failed("辅助模型返回空提取结果".into()));
            }
            Ok(text)
        })
    }
}

impl ExecutionContext {
    fn boundary(&self) -> Result<domain::ContextBoundary, ToolError> {
        let state = self.shared.lock().map_err(|_| ToolError::CommitFailed)?;
        let session = state
            .sessions
            .get(&self.request.session_id)
            .ok_or(ToolError::CommitFailed)?;
        Ok(domain::ContextBoundary {
            through_entry_id: session
                .journal
                .as_ref()
                .and_then(|journal| journal.entries().last())
                .map(|entry| entry.entry_id),
            after_turn_id: None,
        })
    }

    fn commit(&self, payload: domain::EntryPayload, at: i64) -> Result<(), ToolError> {
        let mut state = self.shared.lock().map_err(|_| ToolError::CommitFailed)?;
        state
            .sessions
            .get_mut(&self.request.session_id)
            .ok_or(ToolError::CommitFailed)?
            .append(payload, at)
            .map_err(|_| ToolError::CommitFailed)?;
        Ok(())
    }
}
