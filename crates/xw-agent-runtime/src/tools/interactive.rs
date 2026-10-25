use std::{collections::HashSet, path::PathBuf};

use serde::Deserialize;
use serde_json::json;
use xw_agent_types::{InteractionAnswer, InteractionRequest, PermissionTarget, ToolDeclaration};

use super::ToolOutput;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QuestionArgs {
    question: String,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default)]
    multi_select: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PermissionArgs {
    path: String,
    is_directory: bool,
    reason: String,
}

pub fn declarations() -> Vec<ToolDeclaration> {
    [
        (
            "AskUserQuestion",
            "Ask a necessary clarifying question. Optional ordered choices, single or multiple, \
             and free text are supported. The tool waits for the user's answer before continuing.",
            json!({
                "type": "object", "properties": {
                    "question": {"type": "string"},
                    "options": {"type": "array", "maxItems": 12, "items": {"type": "string"}},
                    "multi_select": {"type": "boolean"}
                }, "required": ["question"], "additionalProperties": false
            }),
        ),
        (
            "RequestPermission",
            "Request session write access to a file or directory outside the writable scope. \
             Use an absolute or ~/ path and explain why. Only the user's explicit approval \
             grants access. The tool waits and returns approval or refusal.",
            json!({
                "type": "object", "properties": {
                    "path": {"type": "string"}, "is_directory": {"type": "boolean"},
                    "reason": {"type": "string"}
                }, "required": ["path", "is_directory", "reason"], "additionalProperties": false
            }),
        ),
    ]
    .into_iter()
    .map(|(name, description, parameters)| ToolDeclaration {
        name: name.into(),
        description: description.into(),
        parameters_json: parameters.to_string(),
        constrained_sampling_json: None,
    })
    .collect()
}

pub fn parse(name: &str, arguments: &str) -> Result<InteractionRequest, String> {
    if arguments.len() > 64 * 1024 {
        return Err("交互参数超过大小上限".into());
    }
    match name {
        "AskUserQuestion" => {
            let args: QuestionArgs = serde_json::from_str(arguments)
                .map_err(|_| "问题参数无效，请核对参数名称和类型")?;
            if args.question.trim().is_empty() || args.options.len() > 12 {
                return Err("问题不能为空，选项最多 12 个".into());
            }
            Ok(InteractionRequest::Question {
                question: args.question,
                options: args.options,
                multi_select: args.multi_select,
            })
        }
        "RequestPermission" => {
            let args: PermissionArgs = serde_json::from_str(arguments)
                .map_err(|_| "权限参数无效，请核对参数名称和类型")?;
            let path = if let Some(rest) = args.path.strip_prefix("~/") {
                dirs::home_dir().ok_or("无法确定用户主目录")?.join(rest)
            } else {
                PathBuf::from(&args.path)
            };
            let path = crate::permission::resolve(&path)?;
            if let Ok(metadata) = path.metadata()
                && metadata.is_dir() != args.is_directory
            {
                return Err("目标类型与请求的文件／目录范围不符".into());
            }
            Ok(InteractionRequest::Permission {
                target: PermissionTarget {
                    path: path.to_string_lossy().into_owned(),
                    is_directory: args.is_directory,
                },
                reason: args.reason,
            })
        }
        _ => Err("未知交互工具".into()),
    }
}

pub fn validate_answer(
    request: &InteractionRequest,
    answer: &InteractionAnswer,
) -> Result<(), String> {
    match (request, answer) {
        (
            InteractionRequest::Question {
                options,
                multi_select,
                ..
            },
            InteractionAnswer::Question {
                selected_indices,
                text,
            },
        ) => {
            let mut selected = HashSet::new();
            if (!multi_select && selected_indices.len() > 1)
                || selected_indices
                    .iter()
                    .any(|index| *index as usize >= options.len() || !selected.insert(*index))
                || text.as_ref().is_some_and(|text| text.len() > 64 * 1024)
                || (selected_indices.is_empty()
                    && text.as_ref().is_none_or(|text| text.trim().is_empty()))
            {
                return Err("回答须包含有效选项或非空文字".into());
            }
        }
        (InteractionRequest::Permission { .. }, InteractionAnswer::Permission { .. }) => {}
        _ => return Err("回答类型与交互请求不符".into()),
    }
    Ok(())
}

pub fn result(
    request: &InteractionRequest,
    answer: &InteractionAnswer,
) -> Result<ToolOutput, String> {
    validate_answer(request, answer)?;
    let text = match (request, answer) {
        (
            InteractionRequest::Question { options, .. },
            InteractionAnswer::Question {
                selected_indices,
                text,
            },
        ) => {
            let mut parts = selected_indices
                .iter()
                .map(|index| options[*index as usize].clone())
                .collect::<Vec<_>>();
            if let Some(text) = text.as_ref().filter(|text| !text.trim().is_empty()) {
                parts.push(text.clone());
            }
            format!("用户回答：\n{}", parts.join("\n"))
        }
        (
            InteractionRequest::Permission { target, .. },
            InteractionAnswer::Permission { allow },
        ) => format!(
            "用户已{}写入{}：{}{}",
            if *allow { "批准" } else { "拒绝" },
            if target.is_directory {
                "目录及子路径"
            } else {
                "文件"
            },
            target.path,
            if *allow {
                "；权限已在本会话生效。"
            } else {
                "；不得绕过拒绝或反复请求。"
            },
        ),
        _ => unreachable!("validated answer"),
    };
    Ok(ToolOutput {
        text,
        metadata_json: None,
    })
}
