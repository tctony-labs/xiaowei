use std::{collections::BTreeSet, sync::Arc};

use xw_agent_runtime::tools::{AgentTool, RecoveryPolicy};
use xw_agent_types::{AgentMessage, ContextBoundary, SystemContext, ToolDeclaration};

use crate::{AgentError, session::Session};

#[derive(Clone)]
pub struct ToolRegistration {
    pub(crate) id: String,
    pub(crate) tool: Arc<dyn AgentTool>,
    pub(crate) declaration: ToolDeclaration,
    rules: std::collections::BTreeMap<String, String>,
    pub(crate) recovery: RecoveryPolicy,
}

impl ToolRegistration {
    pub fn new(id: impl Into<String>, tool: Arc<dyn AgentTool>) -> Self {
        Self {
            id: id.into(),
            declaration: tool.declaration(),
            rules: tool.rules(),
            recovery: tool.recovery_policy(),
            tool,
        }
    }
}

pub(crate) fn validate(tools: &[ToolRegistration]) -> Result<(), AgentError> {
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let builtins = builtin_declarations(true);
    let mut rules = BTreeSet::new();
    for tool in tools {
        if tool.id.trim().is_empty() || !ids.insert(&tool.id) {
            return Err(AgentError::InvalidArgument("tool registration id"));
        }
        if !names.insert(&tool.declaration.name)
            || builtins
                .iter()
                .any(|builtin| builtin.name == tool.declaration.name)
        {
            return Err(AgentError::InvalidArgument("duplicate tool name"));
        }
        for name in tool.rules.keys() {
            if !name.starts_with("tool.") || !rules.insert(name) {
                return Err(AgentError::InvalidArgument("tool rule name"));
            }
        }
    }
    assemble(None, tools)?;
    assemble(Some("/workspace"), tools)?;
    Ok(())
}

fn builtin_declarations(has_cwd: bool) -> Vec<ToolDeclaration> {
    if has_cwd {
        let mut tools = xw_agent_runtime::tools::declarations();
        if let Some(bash) = xw_agent_runtime::tools::bash::declaration() {
            tools.push(bash);
        }
        tools.extend(xw_agent_runtime::tools::search_declarations());
        tools.extend(xw_agent_runtime::tools::interactive::declarations());
        tools.push(xw_agent_runtime::tools::todo::declaration());
        tools
    } else {
        vec![]
    }
}

fn assemble(
    cwd: Option<&str>,
    registered: &[ToolRegistration],
) -> Result<SystemContext, AgentError> {
    let mut tools = builtin_declarations(cwd.is_some());
    tools.extend(registered.iter().map(|tool| tool.declaration.clone()));
    let mut context = crate::build_chat_system_context(tools).map_err(|_| AgentError::Internal)?;
    for tool in registered {
        for (name, rule) in &tool.rules {
            if context
                .instructions
                .insert(name.clone(), rule.clone())
                .is_some()
            {
                return Err(AgentError::InvalidArgument("duplicate tool rule"));
            }
        }
    }
    if let Some(cwd) = cwd {
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

pub(crate) fn bind(session: &mut Session, tools: &[ToolRegistration]) -> Result<(), AgentError> {
    session.tool_context = Some(assemble(session.view.cwd.as_deref(), tools)?);
    session.tools = tools.to_vec();
    Ok(())
}

pub(crate) fn context(session: &Session) -> Result<SystemContext, AgentError> {
    session.tool_context.clone().ok_or(AgentError::Internal)
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
