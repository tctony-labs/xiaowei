use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Deserialize;
use serde_json::json;
use xw_agent_types::ToolDeclaration;

use super::ToolOutput;
use crate::resources::{ResourceCache, ResourceScope, markdown_files};

pub type CommandSnapshot = BTreeMap<String, CommandEntry>;

#[derive(Debug)]
pub struct CommandBody {
    pub description: Option<String>,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct CommandEntry {
    pub name: String,
    pub path: PathBuf,
    pub hash: String,
    pub scope: ResourceScope,
    pub body: Arc<CommandBody>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    name: String,
}

pub fn declaration() -> ToolDeclaration {
    ToolDeclaration {
        name: "Command".into(),
        description: "Load a named command template from the available command catalog. \
            Use when the user names a command or the task clearly matches its description. \
            This loads instructions only; it does not execute shell commands or grant permissions."
            .into(),
        parameters_json: json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Command name from the catalog."}
            },
            "required": ["name"],
            "additionalProperties": false
        })
        .to_string(),
        constrained_sampling_json: None,
    }
}

pub(crate) fn scan(
    cache: &mut ResourceCache,
    directory: &Path,
    scope: ResourceScope,
    commands: &mut CommandSnapshot,
) {
    for path in markdown_files(directory) {
        let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if name.is_empty()
            || name
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == '/' || c == '\\')
        {
            log::warn!(
                "Agent command skipped path={} reason=invalid_name",
                path.display()
            );
            continue;
        }
        let Some(file) = cache.read(&path) else {
            continue;
        };
        let parsed = file.command.get_or_init(|| parse(&file.text).map(Arc::new));
        match parsed {
            Ok(body) => {
                commands.insert(
                    name.to_owned(),
                    CommandEntry {
                        name: name.to_owned(),
                        path: file.path.clone(),
                        hash: file.hash.clone(),
                        scope,
                        body: body.clone(),
                    },
                );
            }
            Err(reason) => {
                log::warn!(
                    "Agent command skipped path={} reason={reason}",
                    path.display()
                );
                cache.invalidate(&file.path);
            }
        }
    }
}

fn parse(text: &str) -> Result<CommandBody, &'static str> {
    let text = text.trim();
    let (description, body) = if let Some(after_open) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    {
        let end = after_open.find("\n---").ok_or("missing_frontmatter_end")?;
        let yaml: serde_yaml::Value =
            serde_yaml::from_str(&after_open[..end]).map_err(|_| "invalid_frontmatter")?;
        let description = yaml
            .get("description")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        (description, after_open[end + 4..].trim())
    } else {
        (None, text)
    };
    if body.is_empty() {
        return Err("empty_body");
    }
    Ok(CommandBody {
        description,
        text: body.to_owned(),
    })
}

pub fn execute(commands: &CommandSnapshot, arguments: &str) -> Result<ToolOutput, String> {
    let arguments: Arguments =
        serde_json::from_str(arguments).map_err(|_| "Command 需要 name 字符串参数")?;
    let entry = commands
        .get(&arguments.name)
        .ok_or_else(|| format!("当前运行没有可用命令：{}", arguments.name))?;
    let text = format!(
        "命令：{}\n来源：{}\n以下正文仅用于当前任务，引用文件相对此文件目录解析；\
             加载不执行脚本或授予权限。\n\n{}",
        entry.name,
        entry.path.display(),
        entry.body.text,
    );
    if text.len() > super::filesystem::MAX_OUTPUT_BYTES {
        return Err("命令正文超过工具输出的 64 KiB 上限，未加载；请缩小命令正文".into());
    }
    Ok(ToolOutput {
        text,
        metadata_json: Some(
            json!({"command": {
                "name": entry.name, "path": entry.path, "hash": entry.hash
            }})
            .to_string(),
        ),
    })
}
