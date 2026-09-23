use crate::{invalid, pb, sql, Database, Result};
use sql::{sql_parameter::Source, sql_value::Kind};

fn text(value: String) -> sql::SqlParameter {
    sql::SqlParameter {
        source: Some(Source::Literal(sql::SqlValue {
            kind: Some(Kind::Text(value)),
        })),
    }
}

fn key(key: &str, allow_empty: bool) -> Result<()> {
    if (!allow_empty && key.is_empty()) || key.len() > 1024 || key.contains('\0') {
        return Err(invalid("Meta key must be 1–1024 UTF-8 bytes without NUL"));
    }
    Ok(())
}

fn as_text(value: sql::SqlValue) -> Result<String> {
    match value.kind {
        Some(Kind::Text(value)) => Ok(value),
        _ => Err(invalid("Meta contains a non-text value")),
    }
}

fn validate_json(json: &str) -> Result<()> {
    if json.len() > 1024 * 1024 {
        return Err(invalid("Meta JSON exceeds 1 MiB"));
    }
    serde_json::from_str::<serde_json::Value>(json).map_err(|_| invalid("Invalid meta JSON"))?;
    Ok(())
}

impl Database {
    pub(crate) async fn meta_get(&self, request: pb::KvKey) -> Result<pb::KvValue> {
        key(&request.key, false)?;
        let result = self
            .query(sql::SqlStatement {
                sql: "SELECT value FROM meta WHERE key=?".into(),
                parameters: vec![text(request.key)],
                expected_rows: None,
            })
            .await?;
        let json = result
            .rows
            .into_iter()
            .next()
            .map(|mut row| as_text(row.cells.remove(0)))
            .transpose()?;
        if let Some(json) = &json {
            validate_json(json)?;
        }
        Ok(pb::KvValue { json })
    }

    pub(crate) async fn meta_set(&self, request: pb::KvEntry) -> Result<xw_contracts::xiaowei::common::Empty> {
        key(&request.key, false)?;
        validate_json(&request.json)?;
        self.execute(sql::SqlStatement {
            sql: "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value".into(),
            parameters: vec![text(request.key), text(request.json)],
            expected_rows: None,
        })
        .await?;
        Ok(Default::default())
    }

    pub(crate) async fn meta_delete(&self, request: pb::KvKey) -> Result<pb::KvDeleted> {
        key(&request.key, false)?;
        let result = self
            .execute(sql::SqlStatement {
                sql: "DELETE FROM meta WHERE key=?".into(),
                parameters: vec![text(request.key)],
                expected_rows: None,
            })
            .await?;
        Ok(pb::KvDeleted {
            deleted: result.affected_rows != 0,
        })
    }

    pub(crate) async fn meta_list(&self, request: pb::KvPrefix) -> Result<pb::KvEntries> {
        key(&request.prefix, true)?;
        let result = self
            .query(sql::SqlStatement {
                sql: "SELECT key,value FROM meta WHERE substr(key,1,length(?1))=?1 COLLATE BINARY
                ORDER BY key COLLATE BINARY"
                    .into(),
                parameters: vec![text(request.prefix)],
                expected_rows: None,
            })
            .await?;
        let mut entries = Vec::new();
        for mut row in result.rows {
            let json = as_text(row.cells.remove(1))?;
            validate_json(&json)?;
            entries.push(pb::KvEntry {
                key: as_text(row.cells.remove(0))?,
                json,
            });
        }
        Ok(pb::KvEntries { entries })
    }
}
