use std::{collections::HashMap, io::Read, path::PathBuf};

use serde::Deserialize;
use serde_json::json;
use similar::{ChangeTag, TextDiff};
use tokio_util::sync::CancellationToken;
use xw_agent_types::{AgentMessage, ContentBlock, PermissionTarget, ToolDeclaration};

use crate::permission;

mod search;

pub use search::declarations as search_declarations;

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub struct ToolOutput {
    pub text: String,
    pub metadata_json: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadArgs {
    path: String,
    #[serde(default = "first_line")]
    offset: usize,
    limit: Option<usize>,
    #[serde(default)]
    allow_missing: bool,
}

fn first_line() -> usize {
    1
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteArgs {
    path: String,
    contents: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditArgs {
    path: String,
    old_string: String,
    new_string: String,
    #[serde(default)]
    replace_all: bool,
}

pub fn declarations() -> Vec<ToolDeclaration> {
    [
        (
            "Read",
            "Read a UTF-8 text file as numbered lines. Relative paths use cwd. \
            Use offset (1-based) and limit to read a range. PDF is not supported.",
            json!({
                "type":"object", "properties": {
                    "path":{"type":"string"}, "offset":{"type":"integer","minimum":1},
                    "limit":{"type":"integer","minimum":1}, "allow_missing":{"type":"boolean"}
                }, "required":["path"], "additionalProperties":false
            }),
        ),
        (
            "Write",
            "Write UTF-8 contents, overwriting existing files and creating parent \
            directories. Relative paths use cwd. Prefer small calls for large content.",
            json!({
                "type":"object", "properties": {
                    "path":{"type":"string"}, "contents":{"type":"string"}
                }, "required":["path","contents"], "additionalProperties":false
            }),
        ),
        (
            "Edit",
            "Replace an exact string in an existing UTF-8 file. Requires one match \
            unless replace_all is true. Relative paths use cwd.",
            json!({
                "type":"object", "properties": {
                    "path":{"type":"string"}, "old_string":{"type":"string"},
                    "new_string":{"type":"string"}, "replace_all":{"type":"boolean"}
                }, "required":["path","old_string","new_string"], "additionalProperties":false
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

/// One run's executors. Read dedup is rebuilt only from committed successful results.
pub struct FileTools {
    cwd: PathBuf,
    grants: Vec<PermissionTarget>,
    reads: HashMap<(PathBuf, usize, Option<usize>), blake3::Hash>,
}

impl FileTools {
    pub fn new(cwd: PathBuf, grants: Vec<PermissionTarget>, history: &[AgentMessage]) -> Self {
        let mut tools = Self {
            cwd,
            grants,
            reads: HashMap::new(),
        };
        let mut pending = HashMap::new();
        for message in history {
            match message {
                AgentMessage::Assistant(message) => {
                    // Provider IDs are generation-local, so discard prior unmatched IDs.
                    pending.clear();
                    for block in &message.content {
                        if let ContentBlock::ToolCall {
                            id,
                            name,
                            arguments_json: Some(args),
                            ..
                        } = block
                            && name == "Read"
                            && let Ok(args) = serde_json::from_str::<ReadArgs>(args)
                        {
                            pending.insert(id.clone(), args);
                        }
                    }
                }
                AgentMessage::ToolResult(result) if !result.is_error => {
                    if let Some(args) = pending.remove(&result.tool_call_id)
                        && let Some(ContentBlock::Text { text, .. }) = result.content.first()
                        && !text.contains("content unchanged since last read")
                        && let Ok(path) = tools.path(&args.path)
                    {
                        tools.reads.insert(
                            (path, args.offset, args.limit),
                            blake3::hash(text.as_bytes()),
                        );
                    }
                }
                _ => {}
            }
        }
        tools
    }

    fn path(&self, value: &str) -> Result<PathBuf, String> {
        if value.trim().is_empty() {
            return Err("path 不能为空".into());
        }
        permission::resolve(&self.cwd.join(value))
    }

    /// Runs on the blocking pool; the caller awaits settlement even after cancellation.
    pub fn execute(&mut self, name: &str, arguments: &str) -> Result<ToolOutput, String> {
        self.execute_cancellable(name, arguments, &CancellationToken::new())
    }

    /// Searches observe cancellation; writes and edits still settle their actual operation.
    pub fn execute_cancellable(
        &mut self,
        name: &str,
        arguments: &str,
        cancellation: &CancellationToken,
    ) -> Result<ToolOutput, String> {
        if !self.cwd.is_dir() {
            return Err("会话工作目录不存在".into());
        }
        match name {
            "Glob" | "Grep" => search::execute(self, name, arguments, cancellation),
            "Read" => self.read(parse(arguments)?),
            "Write" => {
                let args: WriteArgs = parse(arguments)?;
                let path =
                    permission::check_write(&self.cwd, &self.path(&args.path)?, &self.grants)?;
                let before = if path.exists() {
                    if !path.metadata().map_err(|e| e.to_string())?.is_file() {
                        return Err("只能写入普通文件".into());
                    }
                    read_text(&path).ok()
                } else {
                    Some(String::new())
                };
                std::fs::create_dir_all(path.parent().ok_or("文件路径无父目录")?)
                    .map_err(|e| e.to_string())?;
                // Recheck after creating parents, before writing the final file.
                let path = permission::check_write(&self.cwd, &path, &self.grants)?;
                std::fs::write(&path, &args.contents).map_err(|e| e.to_string())?;
                Ok(ToolOutput {
                    text: format!(
                        "Wrote {} lines to {}",
                        args.contents.lines().count(),
                        path.display()
                    ),
                    metadata_json: before.map(|before| diff(&path, &before, &args.contents)),
                })
            }
            "Edit" => {
                let args: EditArgs = parse(arguments)?;
                if args.old_string.is_empty() {
                    return Err("old_string 不能为空".into());
                }
                let path =
                    permission::check_write(&self.cwd, &self.path(&args.path)?, &self.grants)?;
                let before = read_text(&path)?;
                let matches = before.matches(&args.old_string).count();
                if matches == 0 || (matches != 1 && !args.replace_all) {
                    return Err(format!("old_string 匹配 {matches} 次；默认必须唯一匹配"));
                }
                let after = before.replace(&args.old_string, &args.new_string);
                let path = permission::check_write(&self.cwd, &path, &self.grants)?;
                std::fs::write(&path, &after).map_err(|e| e.to_string())?;
                Ok(ToolOutput {
                    text: format!("Replaced {matches} occurrence(s) in {}", path.display()),
                    metadata_json: Some(diff(&path, &before, &after)),
                })
            }
            _ => Err("工具未开放或不存在".into()),
        }
    }

    fn read(&mut self, args: ReadArgs) -> Result<ToolOutput, String> {
        if args.offset == 0 || args.limit == Some(0) {
            return Err("offset 和 limit 必须大于 0".into());
        }
        let path = self.path(&args.path)?;
        if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        {
            return Err("暂不支持读取 PDF 文件".into());
        }
        let content = match read_text(&path) {
            Ok(content) => content,
            Err(_) if args.allow_missing && !path.try_exists().map_err(|e| e.to_string())? => {
                return Ok(ToolOutput {
                    text: format!("File {} does not exist.", path.display()),
                    metadata_json: None,
                });
            }
            Err(error) => return Err(error),
        };
        let lines: Vec<_> = content.lines().collect();
        let start = args.offset.saturating_sub(1).min(lines.len());
        let end = start
            .saturating_add(args.limit.unwrap_or(usize::MAX))
            .min(lines.len());
        let mut text = String::new();
        if start > 0 {
            text.push_str(&format!("... {start} lines not shown ...\n"));
        }
        let mut shown = start;
        for (index, line) in lines.iter().enumerate().take(end).skip(start) {
            let next = format!("{:>6}|{line}\n", index + 1);
            if text.len() + next.len() > MAX_OUTPUT_BYTES {
                if shown == start {
                    return Err("单行内容超过读取输出上限".into());
                }
                break;
            }
            text.push_str(&next);
            shown = index + 1;
        }
        if shown < lines.len() {
            text.push_str(&format!(
                "... {} lines not shown; continue with offset {} ...\n",
                lines.len() - shown,
                shown + 1
            ));
        }
        let key = (path.clone(), args.offset, args.limit);
        let hash = blake3::hash(text.as_bytes());
        if self.reads.get(&key) == Some(&hash) {
            text = format!("File {} content unchanged since last read.", path.display());
        } else {
            self.reads.insert(key, hash);
        }
        Ok(ToolOutput {
            text,
            metadata_json: None,
        })
    }
}

fn parse<T: serde::de::DeserializeOwned>(arguments: &str) -> Result<T, String> {
    serde_json::from_str(arguments).map_err(|_| "工具参数无效，请核对参数名称和类型".into())
}

fn read_text(path: &std::path::Path) -> Result<String, String> {
    if !path.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("只能读取普通文本文件".into());
    }
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("只能读取普通文本文件".into());
    }
    let mut content = String::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|e| e.to_string())?;
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("文件超过 16 MiB 读取上限".into());
    }
    Ok(content)
}

fn diff(path: &std::path::Path, before: &str, after: &str) -> String {
    let diff = TextDiff::from_lines(before, after);
    let additions = diff
        .iter_all_changes()
        .filter(|c| c.tag() == ChangeTag::Insert)
        .count();
    let deletions = diff
        .iter_all_changes()
        .filter(|c| c.tag() == ChangeTag::Delete)
        .count();
    let label = path.to_string_lossy();
    let mut unified = diff
        .unified_diff()
        .header(&label, &label)
        .context_radius(3)
        .to_string();
    if unified.len() > MAX_OUTPUT_BYTES {
        let mut end = MAX_OUTPUT_BYTES;
        while !unified.is_char_boundary(end) {
            end -= 1;
        }
        unified.truncate(end);
        unified.push_str("\n... diff truncated ...");
    }
    json!({"filediff": {"file":label,"additions":additions,"deletions":deletions,
        "unified":unified}})
    .to_string()
}
