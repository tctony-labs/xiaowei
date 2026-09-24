//! Clipboard persistence. SQL and migration definitions stay inside Storage.

pub mod gateway;

use crate::{invalid, sql as storage_pb, Database, Result};
use std::sync::Arc;
use xw_contracts::xiaowei::{clipboard as pb, common::Empty};

const COLUMNS: &str = "id,kind,text,paths,width,height,created_at,last_used_at,
    use_count,favorite,remark,category_id,hash";

pub struct ClipboardDao {
    database: Arc<Database>,
}

impl ClipboardDao {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }

    pub async fn capture(&self, request: pb::CaptureClipboardEntityRequest) -> Result<pb::ClipboardEntity> {
        let result = self
            .database
            .transaction(storage_pb::SqlTransaction {
                steps: vec![statement(
                    &format!(
                        "INSERT INTO clipboard_items(hash,kind,text,paths,width,height,created_at,last_used_at)
                        VALUES(?1,?2,?3,?4,?5,?6,?7,?7)
                        ON CONFLICT(hash) DO UPDATE SET last_used_at=excluded.last_used_at,
                            use_count=clipboard_items.use_count+1 RETURNING {COLUMNS}"
                    ),
                    vec![
                        value(request.hash),
                        value(request.kind),
                        value(request.text),
                        value(serde_json::to_string(&request.paths)?),
                        value(request.width),
                        value(request.height),
                        value(request.created_at_ms),
                    ],
                )],
            })
            .await?;
        record(
            result.results[0]
                .rows
                .first()
                .ok_or_else(|| invalid("Clipboard capture returned no row"))?,
        )
    }

    pub async fn list(&self, request: pb::ClipboardListOptions) -> Result<pb::ClipboardEntityList> {
        let kind = match request.kind.map(pb::ClipboardKind::try_from).transpose() {
            Ok(None) => None,
            Ok(Some(pb::ClipboardKind::Image)) => Some("image"),
            Ok(Some(pb::ClipboardKind::File)) => Some("file"),
            _ => return Err(invalid("Invalid clipboard kind")),
        };
        let query = request.query.unwrap_or_default();
        let limit = request.limit.unwrap_or(50);
        if limit == 0 || limit > 100 || query.len() > 4096 {
            return Err(invalid("Invalid clipboard list options"));
        }
        let query = escape_fts5_query(&query);
        let search_condition = if query.is_empty() {
            "?2=''"
        } else {
            "id IN (SELECT rowid FROM clipboard_fts WHERE clipboard_fts MATCH ?2)"
        };
        let rows = self
            .database
            .query(statement(
                &format!(
                    "SELECT {COLUMNS} FROM clipboard_items
                    WHERE (?1=0 OR favorite=1)
                    AND {search_condition}
                    AND (?5 IS NULL OR kind=?5) AND (?6 IS NULL OR category_id=?6)
                    ORDER BY last_used_at DESC,id DESC LIMIT ?3 OFFSET ?4"
                ),
                vec![
                    value(request.favorites_only.unwrap_or(false)),
                    value(query),
                    value(limit),
                    value(request.offset.unwrap_or(0)),
                    value(kind),
                    value(request.category_id.map(as_id).transpose()?),
                ],
            ))
            .await?;
        Ok(pb::ClipboardEntityList {
            entities: rows.rows.iter().map(record).collect::<Result<_>>()?,
        })
    }

    pub async fn search(&self, request: pb::SearchClipboardEntitiesRequest) -> Result<pb::ClipboardEntityHits> {
        let limit = request.limit.unwrap_or(100);
        if limit == 0 || limit > 100 || request.query.len() > 4096 {
            return Err(invalid("Invalid clipboard search options"));
        }
        let query = escape_fts5_query(&request.query);
        if query.is_empty() {
            return Ok(pb::ClipboardEntityHits { hits: vec![] });
        }

        let rows = self
            .database
            .query(statement(
                &format!(
                    "SELECT {COLUMNS},snippet(clipboard_fts,0,'','','…',32)
                    FROM clipboard_items JOIN clipboard_fts ON clipboard_fts.rowid=clipboard_items.id
                    WHERE clipboard_fts MATCH ?1
                    ORDER BY clipboard_fts.rank,last_used_at DESC,id DESC LIMIT ?2"
                ),
                vec![value(query), value(limit)],
            ))
            .await?;
        let hits = rows
            .rows
            .iter()
            .map(|row| {
                Ok(pb::ClipboardEntityHit {
                    entity: Some(record(row)?),
                    snippet: Row(row).get(13)?,
                })
            })
            .collect::<Result<_>>()?;
        Ok(pb::ClipboardEntityHits { hits })
    }

    pub async fn get(&self, request: pb::ClipboardItemRequest) -> Result<pb::OptionalClipboardEntity> {
        let rows = self
            .database
            .query(statement(
                &format!("SELECT {COLUMNS} FROM clipboard_items WHERE id=?"),
                vec![value(as_id(request.id)?)],
            ))
            .await?;
        Ok(pb::OptionalClipboardEntity {
            entity: rows.rows.first().map(record).transpose()?,
        })
    }

    pub async fn touch(&self, request: pb::TouchClipboardEntityRequest) -> Result<Empty> {
        self.database
            .execute(statement(
                "UPDATE clipboard_items SET last_used_at=?1,use_count=use_count+1 WHERE id=?2",
                vec![value(request.used_at_ms), value(as_id(request.id)?)],
            ))
            .await?;
        Ok(Empty {})
    }

    pub async fn set_favorite(&self, request: pb::FavoriteRequest) -> Result<pb::SetFavoriteResponse> {
        let result = self
            .database
            .execute(statement(
                "UPDATE clipboard_items SET favorite=?1 WHERE id=?2",
                vec![value(request.favorite), value(as_id(request.id)?)],
            ))
            .await?;
        Ok(pb::SetFavoriteResponse {
            updated: result.affected_rows > 0,
        })
    }

    pub async fn set_remark(&self, request: pb::SetRemarkRequest) -> Result<Empty> {
        if request.remark.len() > 65536 {
            return Err(invalid("Remark is too long"));
        }
        let trimmed = request.remark.trim();
        let remark = (!trimmed.is_empty()).then_some(trimmed);
        let result = self
            .database
            .execute(statement(
                "UPDATE clipboard_items SET remark=?1 WHERE id=?2",
                vec![value(remark), value(as_id(request.id)?)],
            ))
            .await?;
        if result.affected_rows == 0 {
            return Err(invalid("Clipboard item not found"));
        }
        Ok(Empty {})
    }

    pub async fn set_category(&self, request: pb::SetCategoryRequest) -> Result<Empty> {
        let result = self
            .database
            .execute(statement(
                "UPDATE clipboard_items SET category_id=?1 WHERE id=?2",
                vec![
                    value(request.category_id.map(as_id).transpose()?),
                    value(as_id(request.id)?),
                ],
            ))
            .await?;
        if result.affected_rows == 0 {
            return Err(invalid("Clipboard item not found"));
        }
        Ok(Empty {})
    }

    pub async fn categories(&self, _: Empty) -> Result<pb::ClipboardCategories> {
        let result = self
            .database
            .query(statement(
                "SELECT id,name,color FROM clipboard_categories ORDER BY id",
                vec![],
            ))
            .await?;
        Ok(pb::ClipboardCategories {
            items: result.rows.iter().map(category).collect::<Result<_>>()?,
        })
    }

    pub async fn save_category(&self, request: pb::SaveCategoryRequest) -> Result<pb::ClipboardCategory> {
        let name = request.name.trim();
        if name.is_empty()
            || name.len() > 256
            || request.color.len() != 7
            || !request.color.starts_with('#')
            || !request.color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(invalid("Invalid category name or color"));
        }
        let step = if let Some(id) = request.id {
            statement(
                "UPDATE clipboard_categories SET name=?1,color=?2 WHERE id=?3 RETURNING id,name,color",
                vec![value(name), value(request.color), value(as_id(id)?)],
            )
        } else {
            statement(
                "INSERT INTO clipboard_categories(name,color) VALUES(?1,?2) RETURNING id,name,color",
                vec![value(name), value(request.color)],
            )
        };
        let result = self
            .database
            .transaction(storage_pb::SqlTransaction { steps: vec![step] })
            .await?;
        category(
            result.results[0]
                .rows
                .first()
                .ok_or_else(|| invalid("Category not found"))?,
        )
    }

    pub async fn delete_category(&self, request: pb::ClipboardCategoryRequest) -> Result<Empty> {
        let result = self
            .database
            .execute(statement(
                "DELETE FROM clipboard_categories WHERE id=?",
                vec![value(as_id(request.id)?)],
            ))
            .await?;
        if result.affected_rows == 0 {
            return Err(invalid("Category not found"));
        }
        Ok(Empty {})
    }

    pub async fn edit_text(
        &self,
        request: pb::EditClipboardEntityTextRequest,
    ) -> Result<pb::EditClipboardEntityTextResponse> {
        if !matches!(request.kind.as_str(), "text" | "largeText") {
            return Err(invalid("Invalid text kind"));
        }
        let id = as_id(request.id)?;
        let mut source = statement(
            "SELECT favorite,remark,category_id,hash,kind FROM clipboard_items
            WHERE id=? AND kind IN ('text','largeText')",
            vec![value(id)],
        );
        source.expected_rows = Some(1);
        let mut target = statement(
            "SELECT coalesce((SELECT id FROM clipboard_items WHERE hash=?1),?2)",
            vec![value(request.hash.clone()), value(id)],
        );
        target.expected_rows = Some(1);
        let steps = vec![
            source,
            target,
            statement(
                "UPDATE clipboard_items SET favorite=favorite OR ?1,
                remark=CASE WHEN ?2 IS NULL THEN remark WHEN remark IS NULL OR remark=?2 THEN ?2
                    ELSE ?2||';'||remark END,
                category_id=coalesce(?3,category_id),last_used_at=?4,use_count=use_count+1
                WHERE id=?5 AND id<>?6",
                vec![
                    reference(0, 0),
                    reference(0, 1),
                    reference(0, 2),
                    value(request.edited_at_ms),
                    reference(1, 0),
                    value(id),
                ],
            ),
            statement(
                "DELETE FROM clipboard_items WHERE id=?1 AND id<>?2",
                vec![value(id), reference(1, 0)],
            ),
            statement(
                "UPDATE clipboard_items SET hash=?1,kind=?2,text=?3,last_used_at=?4,use_count=use_count+1
                WHERE id=?5 AND id=?6",
                vec![
                    value(request.hash),
                    value(request.kind),
                    value(request.text),
                    value(request.edited_at_ms),
                    value(id),
                    reference(1, 0),
                ],
            ),
            statement(
                &format!("SELECT {COLUMNS} FROM clipboard_items WHERE id=?"),
                vec![reference(1, 0)],
            ),
        ];
        let result = self.database.transaction(storage_pb::SqlTransaction { steps }).await?;
        let source = Row(&result.results[0].rows[0]);
        let previous_attachment = Some(pb::AttachmentReference {
            kind: source.get(4)?,
            hash: source.get(3)?,
        });
        let record = result.results[5]
            .rows
            .first()
            .ok_or_else(|| invalid("Clipboard item disappeared"))?;
        Ok(pb::EditClipboardEntityTextResponse {
            entity: Some(self::record(record)?),
            previous_attachment,
        })
    }

    pub async fn delete(&self, request: pb::ClipboardItemRequest) -> Result<pb::DeletedClipboardEntities> {
        let result = self
            .database
            .transaction(storage_pb::SqlTransaction {
                steps: vec![statement(
                    "DELETE FROM clipboard_items WHERE id=? RETURNING kind,hash",
                    vec![value(as_id(request.id)?)],
                )],
            })
            .await?;
        deleted(&result.results[0].rows)
    }

    pub async fn purge_ordinary_batch(
        &self,
        request: pb::PurgeClipboardEntitiesRequest,
    ) -> Result<pb::DeletedClipboardEntities> {
        let result = self
            .database
            .transaction(storage_pb::SqlTransaction {
                steps: vec![statement(
                    "DELETE FROM clipboard_items WHERE id IN
                    (SELECT id FROM clipboard_items WHERE favorite=0 AND category_id IS NULL
                    AND (remark IS NULL OR trim(remark)='') AND last_used_at<?1 LIMIT 100)
                    RETURNING kind,hash",
                    vec![value(request.cutoff_ms)],
                )],
            })
            .await?;
        deleted(&result.results[0].rows)
    }

    pub async fn clear_history_batch(&self, _: Empty) -> Result<pb::DeletedClipboardEntities> {
        let result = self
            .database
            .transaction(storage_pb::SqlTransaction {
                steps: vec![statement(
                    "DELETE FROM clipboard_items WHERE id IN
                    (SELECT id FROM clipboard_items WHERE favorite=0 LIMIT 100) RETURNING kind,hash",
                    vec![],
                )],
            })
            .await?;
        deleted(&result.results[0].rows)
    }

    pub async fn hash_referenced(
        &self,
        request: pb::ClipboardEntityHashRequest,
    ) -> Result<pb::ClipboardEntityHashReference> {
        let result = self
            .database
            .query(statement(
                "SELECT id FROM clipboard_items WHERE hash=?",
                vec![value(request.hash)],
            ))
            .await?;
        Ok(pb::ClipboardEntityHashReference {
            referenced: !result.rows.is_empty(),
        })
    }
}

fn deleted(rows: &[storage_pb::SqlRow]) -> Result<pb::DeletedClipboardEntities> {
    Ok(pb::DeletedClipboardEntities {
        deleted_count: rows.len() as u32,
        attachments: rows
            .iter()
            .map(|row| {
                let row = Row(row);
                Ok(pb::AttachmentReference {
                    kind: row.get(0)?,
                    hash: row.get(1)?,
                })
            })
            .collect::<Result<_>>()?,
    })
}

fn reference(step: u32, column: u32) -> storage_pb::SqlParameter {
    storage_pb::SqlParameter {
        source: Some(storage_pb::sql_parameter::Source::Cell(storage_pb::SqlCellReference {
            step,
            row: 0,
            column,
        })),
    }
}

fn as_id(id: u64) -> Result<i64> {
    i64::try_from(id)
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| invalid("Invalid clipboard ID"))
}

fn statement(sql: &str, parameters: Vec<storage_pb::SqlParameter>) -> storage_pb::SqlStatement {
    storage_pb::SqlStatement {
        sql: sql.into(),
        parameters,
        expected_rows: None,
    }
}

fn value(input: impl IntoValue) -> storage_pb::SqlParameter {
    storage_pb::SqlParameter {
        source: Some(storage_pb::sql_parameter::Source::Literal(storage_pb::SqlValue {
            kind: Some(input.into_value()),
        })),
    }
}

trait IntoValue {
    fn into_value(self) -> storage_pb::sql_value::Kind;
}

impl IntoValue for i64 {
    fn into_value(self) -> storage_pb::sql_value::Kind {
        storage_pb::sql_value::Kind::Integer(self)
    }
}

impl IntoValue for u32 {
    fn into_value(self) -> storage_pb::sql_value::Kind {
        storage_pb::sql_value::Kind::Integer(self.into())
    }
}

impl IntoValue for bool {
    fn into_value(self) -> storage_pb::sql_value::Kind {
        storage_pb::sql_value::Kind::Integer(self.into())
    }
}

impl IntoValue for String {
    fn into_value(self) -> storage_pb::sql_value::Kind {
        storage_pb::sql_value::Kind::Text(self)
    }
}

impl IntoValue for &str {
    fn into_value(self) -> storage_pb::sql_value::Kind {
        storage_pb::sql_value::Kind::Text(self.into())
    }
}

impl<T: IntoValue> IntoValue for Option<T> {
    fn into_value(self) -> storage_pb::sql_value::Kind {
        self.map(IntoValue::into_value)
            .unwrap_or_else(|| storage_pb::sql_value::Kind::Null(Empty {}))
    }
}

struct Row<'a>(&'a storage_pb::SqlRow);

impl Row<'_> {
    fn get<T: FromValue>(&self, index: usize) -> Result<T> {
        T::from_value(
            self.0
                .cells
                .get(index)
                .and_then(|cell| cell.kind.as_ref())
                .ok_or_else(|| invalid("Missing SQL cell"))?,
        )
    }
}

trait FromValue: Sized {
    fn from_value(value: &storage_pb::sql_value::Kind) -> Result<Self>;
}

impl FromValue for String {
    fn from_value(value: &storage_pb::sql_value::Kind) -> Result<Self> {
        match value {
            storage_pb::sql_value::Kind::Text(text) => Ok(text.clone()),
            _ => Err(invalid("Expected SQL text")),
        }
    }
}

impl FromValue for i64 {
    fn from_value(value: &storage_pb::sql_value::Kind) -> Result<Self> {
        match value {
            storage_pb::sql_value::Kind::Integer(number) => Ok(*number),
            _ => Err(invalid("Expected SQL integer")),
        }
    }
}

impl FromValue for u32 {
    fn from_value(value: &storage_pb::sql_value::Kind) -> Result<Self> {
        i64::from_value(value)?
            .try_into()
            .map_err(|_| invalid("SQL integer out of range"))
    }
}

impl FromValue for bool {
    fn from_value(value: &storage_pb::sql_value::Kind) -> Result<Self> {
        Ok(i64::from_value(value)? != 0)
    }
}

impl<T: FromValue> FromValue for Option<T> {
    fn from_value(value: &storage_pb::sql_value::Kind) -> Result<Self> {
        if matches!(value, storage_pb::sql_value::Kind::Null(_)) {
            Ok(None)
        } else {
            T::from_value(value).map(Some)
        }
    }
}

fn record(row: &storage_pb::SqlRow) -> Result<pb::ClipboardEntity> {
    let row = Row(row);
    Ok(pb::ClipboardEntity {
        id: u64::try_from(row.get::<i64>(0)?).map_err(|_| invalid("Invalid record ID"))?,
        kind: row.get(1)?,
        text: row.get(2)?,
        paths: serde_json::from_str(&row.get::<String>(3)?)?,
        width: row.get(4)?,
        height: row.get(5)?,
        created_at_ms: row.get(6)?,
        last_used_at_ms: row.get(7)?,
        use_count: row.get(8)?,
        favorite: row.get(9)?,
        remark: row.get(10)?,
        category_id: row
            .get::<Option<i64>>(11)?
            .map(u64::try_from)
            .transpose()
            .map_err(|_| invalid("Invalid category ID"))?,
        hash: row.get(12)?,
    })
}

fn category(row: &storage_pb::SqlRow) -> Result<pb::ClipboardCategory> {
    let row = Row(row);
    Ok(pb::ClipboardCategory {
        id: u64::try_from(row.get::<i64>(0)?).map_err(|_| invalid("Invalid category ID"))?,
        name: row.get(1)?,
        color: row.get(2)?,
    })
}

// Match the legacy panel: AND whitespace-separated phrases, prefix-match the last term.
// Quotes make user input literal rather than exposing the FTS5 query language.
fn escape_fts5_query(raw: &str) -> String {
    let trimmed = raw.trim();
    let truncated = &trimmed[..trimmed.floor_char_boundary(200)];
    let tokens: Vec<_> = truncated
        .split_whitespace()
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect();
    if tokens.is_empty() {
        return String::new();
    }

    format!("{} *", tokens.join(" "))
}
