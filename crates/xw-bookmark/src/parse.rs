//! Chrome `Bookmarks` JSON 解析，扁平化为 [`BookmarkEntry`]。

use serde::Deserialize;
use std::collections::BTreeMap;

/// 扁平化后的单条书签。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookmarkEntry {
    pub name: String,
    pub url: String,
    /// 所在文件夹路径（从根 folder 名起，用 `/` 连接，如 `书签栏/开发`）。
    pub folder_path: String,
}

#[derive(Debug, Deserialize)]
struct BookmarksFile {
    roots: BTreeMap<String, Node>,
}

/// Chrome 书签节点：`type` 为 `url` / `folder`。未知类型忽略。
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Node {
    Url {
        #[serde(default)]
        name: String,
        #[serde(default)]
        url: String,
    },
    Folder {
        #[serde(default)]
        name: String,
        #[serde(default)]
        children: Vec<Node>,
    },
    #[serde(other)]
    Unknown,
}

/// 解析 Chrome `Bookmarks` JSON，递归扁平化所有 `url` 节点。
pub fn parse_bookmarks(json: &str) -> Result<Vec<BookmarkEntry>, serde_json::Error> {
    let file: BookmarksFile = serde_json::from_str(json)?;
    let mut out = Vec::new();
    for node in file.roots.values() {
        collect(node, "", &mut out);
    }
    Ok(out)
}

fn collect(node: &Node, parent: &str, out: &mut Vec<BookmarkEntry>) {
    match node {
        Node::Url { name, url } => {
            if !url.is_empty() {
                out.push(BookmarkEntry {
                    name: name.clone(),
                    url: url.clone(),
                    folder_path: parent.to_string(),
                });
            }
        }
        Node::Folder { name, children } => {
            let path = if parent.is_empty() {
                name.clone()
            } else {
                format!("{parent}/{name}")
            };
            for child in children {
                collect(child, &path, out);
            }
        }
        Node::Unknown => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
        "checksum": "abc",
        "roots": {
            "bookmark_bar": {
                "type": "folder",
                "name": "书签栏",
                "children": [
                    { "type": "url", "name": "GitHub", "url": "https://github.com" },
                    {
                        "type": "folder",
                        "name": "开发",
                        "children": [
                            { "type": "url", "name": "Rust 文档", "url": "https://doc.rust-lang.org" }
                        ]
                    }
                ]
            },
            "other": {
                "type": "folder",
                "name": "其他书签",
                "children": [
                    { "type": "url", "name": "Empty", "url": "" }
                ]
            }
        },
        "version": 1
    }"#;

    #[test]
    fn parse_flattens_and_records_folder_path() {
        let entries = parse_bookmarks(FIXTURE).unwrap();
        // "Empty" 的 url 为空被跳过；其余两条保留。
        assert_eq!(entries.len(), 2);

        let github = entries.iter().find(|e| e.name == "GitHub").unwrap();
        assert_eq!(github.url, "https://github.com");
        assert_eq!(github.folder_path, "书签栏");

        let rust = entries.iter().find(|e| e.name == "Rust 文档").unwrap();
        assert_eq!(rust.url, "https://doc.rust-lang.org");
        assert_eq!(rust.folder_path, "书签栏/开发");
    }

    #[test]
    fn parse_unknown_node_type_is_ignored() {
        let json = r#"{ "roots": { "bookmark_bar": {
            "type": "folder", "name": "bar", "children": [
                { "type": "something_new", "name": "x" },
                { "type": "url", "name": "ok", "url": "https://ok.com" }
            ]
        } } }"#;
        let entries = parse_bookmarks(json).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "ok");
    }
}
