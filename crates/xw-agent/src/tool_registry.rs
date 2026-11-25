use std::{collections::BTreeSet, sync::Arc};

use xw_agent_runtime::tools::{AgentTool, RecoveryPolicy};
use xw_agent_types::{AgentMessage, EntryPayload, SystemContext, ToolDeclaration};

use crate::{AgentError, PermissionMode, session::Session};

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
    let permission_mode = PermissionMode::Interactive;
    let builtins = builtin_declarations(true, permission_mode);
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
    assemble(None, tools, permission_mode)?;
    assemble(Some("/workspace"), tools, permission_mode)?;
    Ok(())
}

fn builtin_declarations(has_cwd: bool, permission_mode: PermissionMode) -> Vec<ToolDeclaration> {
    if has_cwd {
        let mut tools = xw_agent_runtime::tools::declarations();
        if let Some(bash) = xw_agent_runtime::tools::bash::declaration() {
            tools.push(bash);
        }
        tools.extend(xw_agent_runtime::tools::search_declarations());
        tools.extend(
            xw_agent_runtime::tools::interactive::declarations()
                .into_iter()
                .filter(|tool| {
                    tool.name != "RequestPermission"
                        || permission_mode == PermissionMode::Interactive
                }),
        );
        tools.push(xw_agent_runtime::tools::todo::declaration());
        tools.push(xw_agent_runtime::tools::skill::declaration());
        tools.push(xw_agent_runtime::tools::command::declaration());
        tools
    } else {
        vec![]
    }
}

fn assemble(
    cwd: Option<&str>,
    registered: &[ToolRegistration],
    permission_mode: PermissionMode,
) -> Result<SystemContext, AgentError> {
    let mut tools = builtin_declarations(cwd.is_some(), permission_mode);
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
            format!("当前工作目录：{cwd}\n文件工具的相对路径基于此目录。"),
        );
        context.instructions.insert(
            "environment.permissions".into(),
            crate::prompts::permissions(permission_mode),
        );
    }
    Ok(context)
}

pub(crate) fn bind(session: &mut Session, tools: &[ToolRegistration]) -> Result<(), AgentError> {
    session.tools = tools.to_vec();
    prepare(session)
}

pub(crate) fn prepare(session: &mut Session) -> Result<(), AgentError> {
    session.tool_context = Some(assemble(
        session.view.cwd.as_deref(),
        &session.tools,
        session.permission_mode,
    )?);
    Ok(())
}

pub(crate) fn context(session: &Session) -> Result<SystemContext, AgentError> {
    session.tool_context.clone().ok_or(AgentError::Internal)
}

pub(crate) fn planned_update(
    session: &Session,
) -> Result<Option<xw_agent_types::SystemContextUpdate>, AgentError> {
    crate::plan_system_context_update(applied_context(session)?.as_ref(), &context(session)?)
        .map_err(|_| AgentError::Internal)
}

fn applied_context(session: &Session) -> Result<Option<SystemContext>, AgentError> {
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
    Ok(previous)
}

pub(crate) fn synchronize(
    session: &mut Session,
    at: i64,
) -> Result<Vec<ToolDeclaration>, AgentError> {
    let desired = context(session)?;
    if let Some(journal) = &mut session.journal {
        if let Some(entry) = crate::sync_system_context(journal, &desired, at)
            .map_err(crate::persistence::storage_error)?
            && let EntryPayload::SystemContext(update) = entry.payload
        {
            session.history.push(AgentMessage::SystemContext { update });
        }
        // Use the exact declarations projected into the model history after synchronization.
        return Ok(applied_context(session)?
            .ok_or(AgentError::Persistence)?
            .tools);
    }

    if let Some(update) = planned_update(session)? {
        session.history.push(AgentMessage::SystemContext { update });
    }
    Ok(desired.tools)
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
