use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// Migrated from xw-domain/clipboard/types.rs.
pub const LARGE_TEXT_THRESHOLD: usize = 9999;

#[derive(Debug, Clone, PartialEq)]
pub enum ClipboardData {
    Text(String),
    Image { data: Vec<u8>, width: u32, height: u32 },
    Files(Vec<String>),
}

impl ClipboardData {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Text(text) if text.len() > LARGE_TEXT_THRESHOLD => "largeText",
            Self::Text(_) => "text",
            Self::Image { .. } => "image",
            Self::Files(_) => "file",
        }
    }

    pub fn hash(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(self.kind());
        match self {
            Self::Text(text) => hash.update(text.as_bytes()),
            Self::Image { data, width, height } => {
                hash.update(width.to_le_bytes());
                hash.update(height.to_le_bytes());
                hash.update(data);
            }
            Self::Files(paths) => {
                for path in paths {
                    hash.update((path.len() as u64).to_le_bytes());
                    hash.update(path.as_bytes());
                }
            }
        }
        format!("{:x}", hash.finalize())
    }

    pub fn is_empty(&self) -> bool {
        match self {
            Self::Text(text) => text.trim().is_empty(),
            Self::Files(paths) => paths.is_empty(),
            Self::Image { data, width, height } => data.is_empty() || *width == 0 || *height == 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardItem {
    pub id: String,
    pub kind: String,
    pub image_path: Option<String>,
    pub text_path: Option<String>,
    pub text: Option<String>,
    pub paths: Vec<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub created_at: i64,
    pub last_used_at: i64,
    pub use_count: u32,
    pub favorite: bool,
    pub remark: Option<String>,
    pub category_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListOptions {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub favorites_only: bool,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub category_id: Option<String>,
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardCategory {
    pub id: String,
    pub name: String,
    pub color: String,
}
