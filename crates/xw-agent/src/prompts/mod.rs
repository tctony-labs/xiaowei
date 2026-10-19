use std::collections::BTreeMap;

use xw_agent_types::{SystemContext, ToolDeclaration, ValidationError};

const READ_RULE: &str = concat!(
    "优先使用 Read 读取文件。按任务需要分页读取；",
    "内容超出单次返回范围时，按工具实际提供的参数继续读取。",
);

const WRITE_RULE: &str = concat!(
    "优先使用 Write 写入文件。大文本分批处理，",
    "单次大文本参数建议不超过约 8000 字符或约 200 行，降低流式截断风险。",
    "分批写入时保留已经写入的内容，并确认最终文件完整。",
);

const EDIT_RULE: &str = concat!(
    "优先使用 Edit 编辑文件。编辑前了解已有内容，优先局部修改，保留无关内容。",
    "大文本分批处理，单次大文本参数建议不超过约 8000 字符或约 200 行，",
    "降低流式截断风险。",
);

/// Assembles instructions from the same declarations the caller actually exposes.
/// It does not register tools, grant permissions or commit context updates.
pub fn build_chat_system_context(
    tools: Vec<ToolDeclaration>,
) -> Result<SystemContext, ValidationError> {
    let mut instructions =
        BTreeMap::from([("base".into(), include_str!("base.md").trim().to_owned())]);

    for tool in &tools {
        let rule = match tool.name.as_str() {
            "Read" => Some(READ_RULE),
            "Write" => Some(WRITE_RULE),
            "Edit" => Some(EDIT_RULE),
            _ => None,
        };
        if let Some(rule) = rule {
            instructions.insert(format!("tool.{}", tool.name), rule.to_owned());
        }
    }

    let context = SystemContext {
        instructions,
        tools,
    };
    context.validate()?;
    Ok(context)
}
