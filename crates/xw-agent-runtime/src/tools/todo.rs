use serde::{Deserialize, Serialize};
use serde_json::json;
use xw_agent_types::ToolDeclaration;

use super::ToolOutput;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct TodoItem {
    id: String,
    content: String,
    status: TodoStatus,
}

#[derive(Deserialize)]
struct Snapshot {
    todos: Vec<TodoItem>,
}

#[derive(Default)]
pub struct TodoWrite {
    todos: Vec<TodoItem>,
}

pub fn declaration() -> ToolDeclaration {
    ToolDeclaration {
        name: "TodoWrite".into(),
        description: "Maintain a structured todo list for the current session. \
            Use this to plan and track progress on multi-step tasks. \
            Each call REPLACES the entire list (unless merge=true), so always \
            send the full list. Status values: \"pending\", \"in_progress\", \
            \"completed\", \"cancelled\". Keep at most one item in_progress at \
            a time. Returns the resulting list."
            .into(),
        parameters_json: json!({
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "description": "The complete list of todos after this update.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {
                                "type": "string",
                                "description": "Stable identifier for the item."
                            },
                            "content": {
                                "type": "string",
                                "description": "Short imperative description."
                            },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed", "cancelled"]
                            }
                        },
                        "required": ["id", "content", "status"]
                    }
                },
                "merge": {
                    "type": "boolean",
                    "description": "If true, merge by id instead of replacing. Defaults to false."
                }
            },
            "required": ["todos"]
        })
        .to_string(),
        constrained_sampling_json: None,
    }
}

impl TodoWrite {
    /// Restore only the complete snapshot of a committed successful tool result.
    pub fn restore(metadata_json: Option<&str>) -> Result<Self, String> {
        let Some(metadata_json) = metadata_json else {
            return Ok(Self::default());
        };
        let metadata: serde_json::Value =
            serde_json::from_str(metadata_json).map_err(|_| "待办结果元数据无效")?;
        let snapshot: Snapshot = serde_json::from_value(metadata["todoWrite"].clone())
            .map_err(|_| "待办结果缺少完整清单")?;
        Ok(Self {
            todos: snapshot.todos,
        })
    }

    pub fn execute(&mut self, arguments: &str) -> Result<ToolOutput, String> {
        let args: serde_json::Value =
            serde_json::from_str(arguments).map_err(|_| "待办参数必须是有效 JSON")?;
        let incoming: Vec<TodoItem> =
            serde_json::from_value(args.get("todos").ok_or("缺少必填参数 todos")?.clone())
                .map_err(|_| "todos 须为包含 id、content 和有效 status 的列表")?;
        let merge = args
            .get("merge")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);

        if merge {
            for item in incoming {
                if let Some(existing) = self.todos.iter_mut().find(|todo| todo.id == item.id) {
                    *existing = item;
                } else {
                    self.todos.push(item);
                }
            }
        } else {
            self.todos = incoming;
        }

        let count = |status| {
            self.todos
                .iter()
                .filter(|todo| todo.status == status)
                .count()
        };
        let in_progress = count(TodoStatus::InProgress);
        let mut summary = format!(
            "Todos updated. {} pending, {in_progress} in_progress, {} completed, {} cancelled.",
            count(TodoStatus::Pending),
            count(TodoStatus::Completed),
            count(TodoStatus::Cancelled),
        );
        if in_progress > 1 {
            summary.push_str(" Warning: more than one item is in_progress; keep just one.");
        }

        Ok(ToolOutput {
            text: summary,
            metadata_json: Some(json!({"todoWrite": {"todos": self.todos}}).to_string()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_merge_and_restore_preserve_order_and_all_statuses() {
        let mut tool = TodoWrite::default();
        let first = tool
            .execute(
                r#"{"todos":[
            {"id":"a","content":"实现工具","status":"in_progress"},
            {"id":"b","content":"测试","status":"pending"},
            {"id":"c","content":"不再需要","status":"cancelled"}
        ]}"#,
            )
            .unwrap();
        let mut tool = TodoWrite::restore(first.metadata_json.as_deref()).unwrap();
        let merged = tool
            .execute(
                r#"{"merge":true,"todos":[
            {"id":"a","content":"已实现工具","status":"completed"},
            {"id":"d","content":"验收","status":"in_progress"}
        ]}"#,
            )
            .unwrap();
        assert_eq!(
            merged.text,
            "Todos updated. 1 pending, 1 in_progress, 1 completed, 1 cancelled."
        );
        let mut restored = TodoWrite::restore(merged.metadata_json.as_deref()).unwrap();
        assert_eq!(restored.todos, tool.todos);
        assert_eq!(
            restored
                .todos
                .iter()
                .map(|todo| todo.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "c", "d"]
        );
        assert_eq!(restored.todos[0].content, "已实现工具");

        restored.execute(r#"{"todos":[]}"#).unwrap();
        let empty = restored.execute(r#"{"merge":true,"todos":[]}"#).unwrap();
        assert!(
            TodoWrite::restore(empty.metadata_json.as_deref())
                .unwrap()
                .todos
                .is_empty()
        );
    }

    #[test]
    fn invalid_items_do_not_replace_the_existing_list() {
        let mut tool = TodoWrite::default();
        tool.execute(r#"{"todos":[{"id":"a","content":"保留","status":"pending"}]}"#)
            .unwrap();
        let before = tool.todos.clone();
        for args in [
            "{",
            "{}",
            r#"{"todos":null}"#,
            r#"{"todos":[{}]}"#,
            r#"{"todos":[{"id":"b","content":"错误","status":"done"}]}"#,
        ] {
            assert!(tool.execute(args).is_err());
            assert_eq!(tool.todos, before);
        }
        assert!(TodoWrite::restore(Some("{}")).is_err());
        assert!(TodoWrite::restore(Some("invalid")).is_err());
    }

    #[test]
    fn multiple_active_items_warn_without_rejecting_the_update() {
        let output = TodoWrite::default()
            .execute(
                r#"{"todos":[
            {"id":"a","content":"first","status":"in_progress"},
            {"id":"b","content":"second","status":"in_progress"}
        ]}"#,
            )
            .unwrap();
        assert!(output.text.contains("Warning"));
        assert_eq!(
            TodoWrite::restore(output.metadata_json.as_deref())
                .unwrap()
                .todos
                .len(),
            2
        );
    }
}
