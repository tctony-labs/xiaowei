use crate::{invalid, sql, validation, Result};
use futures_util::TryStreamExt;
use sql::{sql_parameter::Source, sql_value::Kind};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Either, Row, SqliteConnection, SqlitePool, TypeInfo, ValueRef};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

pub struct Database {
    pub(crate) pool: SqlitePool,
    pub(crate) path: PathBuf,
}

#[derive(Default)]
pub(crate) struct Budget {
    bytes: usize,
    rows: usize,
}

impl Budget {
    fn consume(&mut self, bytes: usize, rows: usize) -> Result<()> {
        self.bytes = self.bytes.saturating_add(bytes);
        self.rows += rows;
        if self.bytes > 4 * 1024 * 1024 || self.rows > 10000 {
            return Err(invalid("SQL result exceeds 4 MiB or 10000 rows"));
        }
        Ok(())
    }
}

impl Database {
    pub async fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .after_connect(|connection, _| {
                Box::pin(async move {
                    let mut handle = connection.lock_handle().await?;
                    unsafe {
                        let code = xw_tokenizer::register(handle.as_raw_handle().as_ptr());
                        if code != libsqlite3_sys::SQLITE_OK {
                            return Err(sqlx::Error::Protocol(format!(
                                "Failed to register Xiaowei FTS5 tokenizer: SQLite code {code}"
                            )));
                        }

                        libsqlite3_sys::sqlite3_limit(
                            handle.as_raw_handle().as_ptr(),
                            libsqlite3_sys::SQLITE_LIMIT_LENGTH,
                            4 * 1024 * 1024,
                        );
                        libsqlite3_sys::sqlite3_limit(
                            handle.as_raw_handle().as_ptr(),
                            libsqlite3_sys::SQLITE_LIMIT_VARIABLE_NUMBER,
                            128,
                        );
                    }
                    Ok(())
                })
            })
            .after_release(|connection, _| {
                Box::pin(async move {
                    connection.lock_handle().await?.remove_progress_handler();
                    Ok(true)
                })
            })
            .connect_with(options)
            .await?;
        sqlx::query("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
            .execute(&pool)
            .await?;
        let database = Self {
            pool,
            path: std::path::absolute(path)?,
        };
        database
            .apply_migrations(crate::clipboard_migrations::registry())
            .await?;
        Ok(database)
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub(crate) async fn query(&self, statement: sql::SqlStatement) -> Result<sql::SqlResult> {
        let mut connection = self.pool.acquire().await?;
        run(&mut connection, &statement, &[], true, &mut Budget::default()).await
    }

    pub(crate) async fn execute(&self, statement: sql::SqlStatement) -> Result<sql::SqlResult> {
        let mut result = self.transaction(sql::SqlTransaction { steps: vec![statement] }).await?;
        Ok(result.results.remove(0))
    }

    pub(crate) async fn transaction(&self, batch: sql::SqlTransaction) -> Result<sql::SqlTransactionResult> {
        if batch.steps.is_empty() || batch.steps.len() > 64 {
            return Err(invalid("A transaction requires 1 to 64 steps"));
        }
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut results = Vec::new();
        let mut budget = Budget::default();
        for statement in &batch.steps {
            results.push(run(&mut transaction, statement, &results, false, &mut budget).await?);
        }
        transaction.commit().await?;
        Ok(sql::SqlTransactionResult { results })
    }
}

pub(crate) async fn run(
    connection: &mut SqliteConnection,
    statement: &sql::SqlStatement,
    previous: &[sql::SqlResult],
    readonly: bool,
    budget: &mut Budget,
) -> Result<sql::SqlResult> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let progress = cancelled.clone();
    connection
        .lock_handle()
        .await?
        .set_progress_handler(1000, move || !progress.load(Ordering::Relaxed));
    let _cancel = CancelOnDrop(cancelled);
    let (columns, statement_readonly) =
        validation::validate(connection, &statement.sql, statement.parameters.len(), readonly).await?;
    budget.consume(columns.iter().map(|name| name.len() + 8).sum(), 0)?;
    let mut query = sqlx::query(&statement.sql).persistent(false);
    for parameter in &statement.parameters {
        let value = match &parameter.source {
            Some(Source::Literal(value)) => value,
            Some(Source::Cell(cell)) => previous
                .get(cell.step as usize)
                .and_then(|result| result.rows.get(cell.row as usize))
                .and_then(|row| row.cells.get(cell.column as usize))
                .ok_or_else(|| invalid("Transaction cell reference is unavailable"))?,
            None => return Err(invalid("SQL parameter source is missing")),
        };
        query = match &value.kind {
            Some(Kind::Null(_)) => query.bind(Option::<String>::None),
            Some(Kind::Integer(value)) => query.bind(*value),
            Some(Kind::Real(value)) if value.is_finite() => query.bind(*value),
            Some(Kind::Text(value)) => query.bind(value.clone()),
            Some(Kind::Blob(value)) => query.bind(value.clone()),
            _ => return Err(invalid("SQL parameter kind is missing or non-finite")),
        };
    }
    let mut result = sql::SqlResult {
        columns,
        ..Default::default()
    };
    #[allow(deprecated)]
    let mut stream = query.fetch_many(&mut *connection);
    while let Some(item) = stream.try_next().await? {
        match item {
            Either::Left(done) => {
                if !statement_readonly {
                    result.affected_rows = done.rows_affected();
                }
            }
            Either::Right(row) => {
                let mut cells = Vec::new();
                budget.consume(16, 1)?;
                for index in 0..row.len() {
                    let raw = row.try_get_raw(index)?;
                    let kind = if raw.is_null() {
                        Kind::Null(Default::default())
                    } else {
                        match raw.type_info().name() {
                            "INTEGER" | "BOOLEAN" => Kind::Integer(row.try_get(index)?),
                            "REAL" => Kind::Real(row.try_get(index)?),
                            "TEXT" => Kind::Text(row.try_get(index)?),
                            "BLOB" => Kind::Blob(row.try_get(index)?),
                            name => return Err(invalid(format!("Unsupported SQLite value: {name}"))),
                        }
                    };
                    let size = match &kind {
                        Kind::Text(text) => text.len(),
                        Kind::Blob(bytes) => bytes.len(),
                        _ => 8,
                    };
                    budget.consume(size + 16, 0)?;
                    cells.push(sql::SqlValue { kind: Some(kind) });
                }
                result.rows.push(sql::SqlRow { cells });
            }
        }
    }
    drop(stream);
    connection.lock_handle().await?.remove_progress_handler();
    if statement
        .expected_rows
        .is_some_and(|count| count as usize != result.rows.len())
    {
        return Err(invalid("SQL returned an unexpected number of rows"));
    }
    Ok(result)
}

struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}
