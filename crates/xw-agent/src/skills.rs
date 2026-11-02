use std::collections::{BTreeMap, BTreeSet};

use xw_agent_runtime::tools::{ToolOutput, skill};
use xw_agent_types::{AgentMessage, ContentBlock};

use crate::{AgentError, session::Session};

const BODY_PREFIX: &str = "skill.body.";

/// Rebuild loaded names from committed context and successful loads after its last update.
/// This also covers an outcome committed just before a context-write failure.
fn loaded_names(history: &[AgentMessage]) -> Result<BTreeSet<String>, AgentError> {
    let mut context = None;
    let mut names = BTreeSet::new();
    let mut calls = BTreeMap::new();

    for message in history {
        match message {
            AgentMessage::SystemContext { update } => {
                let current = update
                    .apply(context.as_ref())
                    .map_err(|_| AgentError::Persistence)?;
                names = current
                    .instructions
                    .keys()
                    .filter_map(|key| key.strip_prefix(BODY_PREFIX).map(str::to_owned))
                    .collect();
                context = Some(current);
            }
            AgentMessage::Assistant(message) => {
                for block in &message.content {
                    if let ContentBlock::ToolCall {
                        id,
                        name,
                        arguments_json: Some(arguments),
                        ..
                    } = block
                        && name == "Skill"
                        && let Ok(arguments) = serde_json::from_str::<serde_json::Value>(arguments)
                        && let Some(name) = arguments.get("name").and_then(|name| name.as_str())
                    {
                        calls.insert(id.clone(), name.to_owned());
                    }
                }
            }
            AgentMessage::ToolResult(result) if result.tool_name == "Skill" => {
                if let Some(name) = calls.remove(&result.tool_call_id)
                    && !result.is_error
                {
                    names.insert(name);
                }
            }
            _ => {}
        }
    }
    Ok(names)
}

pub(crate) fn prepare(
    session: &mut Session,
    skills: skill::SkillSnapshot,
) -> Result<(), AgentError> {
    let loaded = loaded_names(&session.history)?;
    let context = session.tool_context.as_mut().ok_or(AgentError::Internal)?;
    context
        .instructions
        .retain(|key, _| !key.starts_with(BODY_PREFIX));
    if session.view.cwd.is_some() {
        let mut catalog =
            String::from("可用技能：任务匹配简介或用户点名时，用 Skill 按名称加载正文。\n");
        for entry in skills.values() {
            catalog.push_str(&format!("- {}: {}\n", entry.name, entry.description.trim()));
        }
        if skills.is_empty() {
            catalog.push_str("当前没有可用技能。\n");
        }
        context
            .instructions
            .insert("skills.catalog".into(), catalog);
        for name in loaded {
            if let Some(entry) = skills.get(&name) {
                context
                    .instructions
                    .insert(entry.instruction_key(), entry.instructions());
            }
        }
    }
    log::debug!(
        "Agent skill snapshot prepared session={} available={}",
        session.view.session_id,
        skills.len(),
    );
    session.skills = skills;
    Ok(())
}

pub(crate) fn execute(session: &Session, arguments: &str) -> Result<ToolOutput, String> {
    let entry = skill::resolve(&session.skills, arguments)?;
    let already_loaded = session
        .tool_context
        .as_ref()
        .is_some_and(|context| context.instructions.contains_key(&entry.instruction_key()));
    Ok(entry.output(already_loaded))
}

/// Called after the successful result is durable. The closed tool batch commits the context update.
pub(crate) fn activate(session: &mut Session, arguments: &str) -> Result<(), AgentError> {
    let entry = skill::resolve(&session.skills, arguments).map_err(|_| AgentError::Internal)?;
    session
        .tool_context
        .as_mut()
        .ok_or(AgentError::Internal)?
        .instructions
        .insert(entry.instruction_key(), entry.instructions());
    Ok(())
}
