use xw_agent_runtime::resources::ResourceSnapshot;

use crate::{AgentError, session::Session};

pub(crate) fn prepare(session: &mut Session, snapshot: ResourceSnapshot) -> Result<(), AgentError> {
    let context = session.tool_context.as_mut().ok_or(AgentError::Internal)?;
    context
        .instructions
        .retain(|key| !key.starts_with("rules."));

    if !snapshot.rules.is_empty() {
        let mut index = String::from(
            "规则文件按以下顺序生效：user 在前、project 在后；冲突时 project 优先。\n\
             同一作用域先 AGENTS.md，再按文件名升序读取 rules/*.md。\n\
             每个具名片段的更新替换该片段旧正文，撤销后不再作为当前规则。\n",
        );
        for rule in &snapshot.rules {
            index.push_str(&format!("- {}: {}\n", rule.key, rule.file.path.display()));
            context.instructions.insert(
                rule.key.clone(),
                format!(
                    "规则来源：{}\n相对文件引用基于此文件所在目录。\n\n{}",
                    rule.file.path.display(),
                    rule.file.text.trim(),
                ),
            );
        }
        context.instructions.insert("rules.index".into(), index);
    }

    if session.view.cwd.is_some() {
        let mut catalog = String::from(
            "可用命令模板：用户点名命令或任务明确匹配简介时，用 Command 按名称加载正文。\n",
        );
        for entry in snapshot.commands.values() {
            let description = entry.body.description.as_deref().unwrap_or("按名称加载");
            catalog.push_str(&format!("- {}: {}\n", entry.name, description));
        }
        if snapshot.commands.is_empty() {
            catalog.push_str("当前没有可用命令。\n");
        }
        context
            .instructions
            .insert("commands.catalog".into(), catalog);
    }
    log::debug!(
        "Agent resources prepared session={} rules={} commands={}",
        session.view.session_id,
        snapshot.rules.len(),
        snapshot.commands.len()
    );
    session.commands = snapshot.commands;
    Ok(())
}
