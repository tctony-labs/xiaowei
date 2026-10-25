use xw_agent_types::{AgentMessage, ContextBoundary, SystemContext};

use crate::{AgentError, session::Session};

pub(crate) fn context(session: &Session) -> Result<SystemContext, AgentError> {
    let tools = if session.view.cwd.is_some() {
        let mut tools = xw_agent_runtime::tools::declarations();
        if let Some(bash) = xw_agent_runtime::tools::bash::declaration() {
            tools.push(bash);
        }
        tools.extend(xw_agent_runtime::tools::search_declarations());
        tools.extend(xw_agent_runtime::tools::interactive::declarations());
        tools
    } else {
        vec![]
    };
    let mut context = crate::build_chat_system_context(tools).map_err(|_| AgentError::Internal)?;
    if let Some(cwd) = &session.view.cwd {
        context.instructions.insert(
            "environment.cwd".into(),
            format!(
                "当前工作目录：{cwd}\n文件工具的相对路径基于此目录。默认可写工作目录及临时目录；\
             工作目录为用户主目录或其祖先时不自动获得整棵目录写权限。\
             其他路径需要已有有效授权。以工具返回的权限结果为准。"
            ),
        );
    }
    Ok(context)
}

pub(crate) fn synchronize(session: &mut Session, at: i64) -> Result<(), AgentError> {
    let desired = context(session)?;
    if let Some(journal) = &mut session.journal {
        crate::sync_system_context(journal, &desired, at)
            .map_err(crate::persistence::storage_error)?;
        let boundary = ContextBoundary {
            through_entry_id: journal.entries().last().map(|e| e.entry_id),
            after_turn_id: None,
        };
        session.history = crate::rebuild_context(journal.entries(), &boundary)
            .map_err(|_| AgentError::Persistence)?
            .messages;
    } else {
        let mut previous = None;
        for message in &session.history {
            if let AgentMessage::SystemContext { update } = message {
                previous = Some(
                    update
                        .apply(previous.as_ref())
                        .map_err(|_| AgentError::Internal)?,
                );
            }
        }
        if let Some(update) = crate::plan_system_context_update(previous.as_ref(), &desired)
            .map_err(|_| AgentError::Internal)?
        {
            session.history.push(AgentMessage::SystemContext { update });
        }
    }
    Ok(())
}

pub(crate) fn has_unclosed_calls(history: &[AgentMessage]) -> bool {
    let mut pending = std::collections::HashSet::new();
    for message in history {
        match message {
            AgentMessage::Assistant(message) => {
                for block in &message.content {
                    if let xw_agent_types::ContentBlock::ToolCall { id, .. } = block {
                        pending.insert(id.as_str());
                    }
                }
            }
            AgentMessage::ToolResult(result) => {
                pending.remove(result.tool_call_id.as_str());
            }
            _ => {}
        }
    }
    !pending.is_empty()
}
