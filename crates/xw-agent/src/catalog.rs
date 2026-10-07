use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use std::{path::Path, time::Duration};

use sqlx::{Row, sqlite::SqliteRow};
use xw_contracts::xiaowei::agent::*;

use crate::AgentError;

type Result<T> = std::result::Result<T, AgentError>;

fn invalid(_: &str) -> AgentError {
    AgentError::InvalidArgument("session directory")
}

fn db_error(error: sqlx::Error) -> AgentError {
    log::error!("Agent SQLite operation failed error={error}");
    AgentError::Index
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AgentIndexRecord {
    pub summary: AgentSessionSummary,
    pub deleting: bool,
}

pub(crate) struct SessionCatalog {
    pool: sqlx::SqlitePool,
}

fn conflict() -> AgentError {
    AgentError::Conflict("session directory revision or identity")
}

fn integer(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| invalid("Revision exceeds SQLite INTEGER"))
}

fn id(value: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value).map_err(|_| invalid("Invalid session/request ID"))?;
    if parsed.get_version_num() != 7 || parsed.to_string() != value {
        return Err(invalid("Expected canonical UUIDv7"));
    }
    Ok(())
}

fn validate_summary(summary: &AgentSessionSummary) -> Result<()> {
    id(&summary.session_id)?;
    if summary.title.chars().count() > 50 || summary.title.chars().any(char::is_control) {
        return Err(invalid("Invalid title"));
    }
    if summary.created_at_ms < 0 || summary.updated_at_ms < summary.created_at_ms {
        return Err(invalid("Invalid session summary"));
    }
    Ok(())
}

fn validate_record(record: &AgentIndexRecord) -> Result<&AgentSessionSummary> {
    let summary = &record.summary;
    validate_summary(summary)?;
    if record.deleting || summary.archived || summary.archive_revision != 1 {
        return Err(invalid("Invalid new session"));
    }
    Ok(summary)
}

fn decode(row: &SqliteRow) -> Result<AgentIndexRecord> {
    Ok(AgentIndexRecord {
        summary: AgentSessionSummary {
            session_id: row.try_get("session_id").map_err(db_error)?,
            title: row.try_get("title").map_err(db_error)?,
            auto_title_enabled: row.try_get("auto_title_enabled").map_err(db_error)?,
            status: AgentSessionStatus::Idle.into(),
            created_at_ms: row.try_get("created_at_ms").map_err(db_error)?,
            updated_at_ms: row.try_get("updated_at_ms").map_err(db_error)?,
            metadata_revision: 1,
            archived: row.try_get("archived").map_err(db_error)?,
            archive_revision: row.try_get::<i64, _>("archive_revision").map_err(db_error)? as u64,
        },
        deleting: row.try_get("deleting").map_err(db_error)?,
    })
}

impl SessionCatalog {
    pub async fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| AgentError::Index)?;
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(db_error)?;
        let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)?;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut *transaction)
            .await
            .map_err(db_error)?;
        match version {
            0 => {
                for statement in BASELINE {
                    sqlx::query(statement)
                        .execute(&mut *transaction)
                        .await
                        .map_err(db_error)?;
                }
                sqlx::query("PRAGMA user_version = 1")
                    .execute(&mut *transaction)
                    .await
                    .map_err(db_error)?;
            }
            1 => {}
            _ => return Err(AgentError::Index),
        }
        transaction.commit().await.map_err(db_error)?;
        log::debug!("Agent SQLite directory opened");
        Ok(Self { pool })
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn retention_policy(&self) -> Result<SessionRetentionPolicy> {
        let row = sqlx::query(
            "SELECT
                (SELECT value FROM meta WHERE key = 'retention.archive_after_days'),
                (SELECT value FROM meta WHERE key = 'retention.delete_after_days')",
        )
        .fetch_one(&self.pool)
        .await
        .map_err(db_error)?;
        let archive = row.try_get::<String, _>(0).map_err(db_error)?;
        let delete = row.try_get::<String, _>(1).map_err(db_error)?;
        let policy = SessionRetentionPolicy {
            archive_after_days: archive.parse().map_err(|_| AgentError::Index)?,
            delete_after_days: delete.parse().map_err(|_| AgentError::Index)?,
        };
        crate::retention::validate_policy(&policy).map_err(|_| AgentError::Index)?;
        Ok(policy)
    }

    pub async fn set_retention_policy(&self, policy: &SessionRetentionPolicy) -> Result<()> {
        crate::retention::validate_policy(policy)?;
        // A single statement commits both keys atomically and preserves unrelated metadata.
        sqlx::query(
            "INSERT INTO meta (key, value) VALUES
                ('retention.archive_after_days', ?), ('retention.delete_after_days', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(policy.archive_after_days.to_string())
        .bind(policy.delete_after_days.to_string())
        .execute(&self.pool)
        .await
        .map_err(db_error)?;
        Ok(())
    }

    pub async fn retention_candidates(&self, archived: bool, cutoff: i64) -> Result<Vec<AgentSessionSummary>> {
        let rows = sqlx::query(
            "SELECT * FROM session WHERE archived = ? AND deleting = 0 AND updated_at_ms <= ?
             ORDER BY updated_at_ms, session_id",
        )
        .bind(archived)
        .bind(cutoff)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        rows.iter().map(|row| Ok(decode(row)?.summary)).collect()
    }

    pub async fn register(&self, record: AgentIndexRecord) -> Result<AgentIndexRecord> {
        let summary = validate_record(&record)?;
        let result = sqlx::query(
            "INSERT INTO session (
                session_id, title, auto_title_enabled, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .bind(&summary.session_id)
        .bind(&summary.title)
        .bind(summary.auto_title_enabled)
        .bind(summary.created_at_ms)
        .bind(summary.updated_at_ms)
        .execute(&self.pool)
        .await
        .map_err(db_error)?;
        if result.rows_affected() == 0 {
            return Err(conflict());
        }
        Ok(record)
    }

    pub async fn get(&self, session_id: &str) -> Result<Option<AgentIndexRecord>> {
        id(session_id)?;
        let row = sqlx::query("SELECT * FROM session WHERE session_id = ?")
            .bind(session_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(db_error)?;
        row.as_ref().map(decode).transpose()
    }

    pub async fn list(&self, request: ListSessionsRequest) -> Result<ListSessionsResponse> {
        let size = if request.page_size == 0 { 50 } else { request.page_size };
        if size > 100 {
            return Err(invalid("Page size exceeds 100"));
        }
        let query = request.query.trim().to_owned();
        if query.len() > 256 {
            return Err(invalid("Query exceeds 256 bytes"));
        }
        let boundary = if request.continuation.is_empty() {
            None
        } else {
            let (archived, filter, time, session): (bool, String, i64, String) =
                serde_json::from_str(&request.continuation).map_err(|_| invalid("Invalid continuation"))?;
            if archived != request.archived || filter != query || time < 0 {
                return Err(invalid("Invalid continuation/filter"));
            }
            id(&session)?;
            Some((time, session))
        };
        let pattern = format!(
            "%{}%",
            query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
        );
        let (time, session) = boundary.clone().unwrap_or_default();
        let rows = sqlx::query(
            "SELECT * FROM session WHERE archived = ? AND deleting = 0
             AND title LIKE ? ESCAPE '\\'
             AND (? = 0 OR updated_at_ms < ? OR (updated_at_ms = ? AND session_id < ?))
             ORDER BY updated_at_ms DESC, session_id DESC LIMIT ?",
        )
        .bind(request.archived)
        .bind(pattern)
        .bind(boundary.is_some())
        .bind(time)
        .bind(time)
        .bind(session)
        .bind(i64::from(size) + 1)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        let mut sessions = rows
            .iter()
            .map(|row| Ok(decode(row)?.summary))
            .collect::<Result<Vec<_>>>()?;
        let more = sessions.len() > size as usize;
        sessions.truncate(size as usize);
        let continuation = if more {
            let last = sessions.last().unwrap();
            serde_json::to_string(&(request.archived, query, last.updated_at_ms, &last.session_id))
                .map_err(|_| AgentError::Internal)?
        } else {
            String::new()
        };
        Ok(ListSessionsResponse { sessions, continuation })
    }

    pub async fn update(&self, summary: AgentSessionSummary) -> Result<AgentIndexRecord> {
        validate_summary(&summary)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)?;
        let result = sqlx::query(
            "UPDATE session SET title = ?, auto_title_enabled = ?,
                updated_at_ms = max(updated_at_ms, ?) WHERE session_id = ? AND deleting = 0
                AND created_at_ms = ?",
        )
        .bind(&summary.title)
        .bind(summary.auto_title_enabled)
        .bind(summary.updated_at_ms)
        .bind(&summary.session_id)
        .bind(summary.created_at_ms)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
        if result.rows_affected() == 0 {
            return Err(conflict());
        }
        let row = sqlx::query("SELECT * FROM session WHERE session_id = ?")
            .bind(&summary.session_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?;
        let record = decode(&row)?;
        tx.commit().await.map_err(db_error)?;
        Ok(record)
    }

    #[cfg(test)]
    pub async fn set_archived(&self, request: SetSessionArchivedRequest) -> Result<SetSessionArchivedResponse> {
        self.set_archived_before(request, None, crate::service::now_ms()?).await
    }

    pub async fn set_archived_before(
        &self,
        request: SetSessionArchivedRequest,
        cutoff: Option<i64>,
        now: i64,
    ) -> Result<SetSessionArchivedResponse> {
        id(&request.session_id)?;
        let revision = integer(request.expected_archive_revision)?;
        if revision == 0 || revision == i64::MAX {
            return Err(invalid("Invalid archive revision"));
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)?;
        let result = sqlx::query(
            "UPDATE session SET
                updated_at_ms = CASE WHEN archived = 1 AND ? = 0 THEN max(updated_at_ms, ?) ELSE updated_at_ms END,
                archive_revision = archive_revision + (archived != ?), archived = ?
             WHERE session_id = ? AND deleting = 0 AND archive_revision = ?
                AND (? IS NULL OR updated_at_ms <= ?)",
        )
        .bind(request.archived)
        .bind(now)
        .bind(request.archived)
        .bind(request.archived)
        .bind(&request.session_id)
        .bind(revision)
        .bind(cutoff)
        .bind(cutoff)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
        if result.rows_affected() == 0 {
            return Err(conflict());
        }
        let row = sqlx::query("SELECT archive_revision FROM session WHERE session_id = ?")
            .bind(&request.session_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?;
        let response = SetSessionArchivedResponse {
            archived: request.archived,
            archive_revision: row.try_get::<i64, _>(0).map_err(db_error)? as u64,
        };
        tx.commit().await.map_err(db_error)?;
        Ok(response)
    }

    pub async fn mark_deleting(
        &self,
        session_id: &str,
        expected_archive_revision: Option<u64>,
    ) -> Result<Option<AgentIndexRecord>> {
        id(session_id)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)?;
        let row = sqlx::query("SELECT * FROM session WHERE session_id = ?")
            .bind(session_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
        let Some(row) = row else { return Ok(None) };
        let mut record = decode(&row)?;
        if !record.deleting
            && let Some(expected) = expected_archive_revision
            && (!record.summary.archived || expected != record.summary.archive_revision)
        {
            return Err(AgentError::Conflict("archive revision"));
        }
        sqlx::query("UPDATE session SET deleting = 1 WHERE session_id = ?")
            .bind(session_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        record.deleting = true;
        tx.commit().await.map_err(db_error)?;
        Ok(Some(record))
    }

    pub async fn list_deleting(&self) -> Result<Vec<AgentIndexRecord>> {
        let rows = sqlx::query("SELECT * FROM session WHERE deleting = 1")
            .fetch_all(&self.pool)
            .await
            .map_err(db_error)?;
        rows.iter().map(decode).collect::<Result<_>>()
    }

    pub async fn remove(&self, session_id: String) -> Result<()> {
        id(&session_id)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db_error)?;
        let row = sqlx::query("SELECT deleting FROM session WHERE session_id = ?")
            .bind(&session_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
        if row.is_some_and(|row| !row.get::<bool, _>(0)) {
            return Err(conflict());
        }
        sqlx::query("DELETE FROM session WHERE session_id = ? AND deleting = 1")
            .bind(&session_id)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
        Ok(())
    }
}

const BASELINE: &[&str] = &[
    "CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)",
    "INSERT INTO meta (key, value) VALUES
        ('retention.archive_after_days', '3'), ('retention.delete_after_days', '0')",
    "CREATE TABLE session (
                    session_id TEXT PRIMARY KEY NOT NULL,
                    title TEXT NOT NULL,
                    auto_title_enabled INTEGER NOT NULL DEFAULT 1 CHECK(auto_title_enabled IN (0, 1)),
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
                    archive_revision INTEGER NOT NULL DEFAULT 1 CHECK(archive_revision > 0),
                    deleting INTEGER NOT NULL DEFAULT 0 CHECK(deleting IN (0, 1))
                )",
    "CREATE INDEX session_recency
                    ON session(archived, deleting, updated_at_ms DESC, session_id DESC)",
];

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
