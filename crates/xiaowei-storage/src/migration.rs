use crate::db::{run, Budget};
use crate::{invalid, pb, Database, Result};
use sqlx::SqliteConnection;
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

const PREFIX: &str = "migration_v2.";

fn validate_registry(migrations: &[pb::DatabaseMigration]) -> Result<()> {
    let mut names = HashSet::new();
    for migration in migrations {
        let name = migration.name.as_bytes();
        if name.len() < 16
            || !name[..14].iter().all(u8::is_ascii_digit)
            || name[14] != b'_'
            || !name[15..]
                .iter()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
            || !names.insert(&migration.name)
        {
            return Err(invalid("Migration names must be unique YYYYMMDDHHmmss_description"));
        }
        if migration.up.is_empty() || migration.down.is_empty() {
            return Err(invalid("Each migration requires explicit up and down statements"));
        }
    }
    Ok(())
}

async fn states(
    connection: &mut SqliteConnection,
    migrations: &[pb::DatabaseMigration],
) -> Result<pb::DatabaseMigrationStates> {
    let stored: Vec<(String, String)> =
        sqlx::query_as("SELECT key,value FROM meta WHERE substr(key,1,13)='migration_v2.'")
            .fetch_all(&mut *connection)
            .await?;
    for (key, _) in &stored {
        if !migrations
            .iter()
            .any(|migration| key == &format!("{PREFIX}{}", migration.name))
        {
            return Err(invalid(
                "Database contains a migration absent from the supplied registry",
            ));
        }
    }
    let mut missing = false;
    let mut result = Vec::new();
    for migration in migrations {
        let key = format!("{PREFIX}{}", migration.name);
        let applied = stored.iter().find(|(name, _)| name == &key);
        if missing && applied.is_some() {
            return Err(invalid("Applied migrations are not a prefix of the supplied registry"));
        }
        missing |= applied.is_none();
        result.push(pb::DatabaseMigrationState {
            name: migration.name.clone(),
            applied_at_seconds: applied.map(|(_, value)| serde_json::from_str(value)).transpose()?,
        });
    }
    Ok(pb::DatabaseMigrationStates { states: result })
}

impl Database {
    pub async fn migration_status(&self, request: pb::DatabaseMigrations) -> Result<pb::DatabaseMigrationStates> {
        validate_registry(&request.migrations)?;
        let mut connection = self.pool.acquire().await?;
        states(&mut connection, &request.migrations).await
    }

    pub async fn apply_migrations(&self, request: pb::DatabaseMigrations) -> Result<pb::DatabaseMigrationStates> {
        validate_registry(&request.migrations)?;
        for migration in &request.migrations {
            let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
            let current = states(&mut transaction, &request.migrations).await?;
            if current
                .states
                .iter()
                .any(|state| state.name == migration.name && state.applied_at_seconds.is_some())
            {
                transaction.commit().await?;
                continue;
            }
            execute_statements(&mut transaction, &migration.up).await?;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| invalid("Clock precedes epoch"))?;
            sqlx::query("INSERT INTO meta(key,value) VALUES(?,?)")
                .bind(format!("{PREFIX}{}", migration.name))
                .bind(now.as_secs().to_string())
                .execute(&mut *transaction)
                .await?;
            transaction.commit().await?;
        }
        self.migration_status(request).await
    }

    pub async fn rollback(&self, request: pb::DatabaseRollback) -> Result<pb::DatabaseMigrationStates> {
        validate_registry(&request.migrations)?;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let current = states(&mut transaction, &request.migrations).await?;
        let last = current
            .states
            .iter()
            .rev()
            .find(|state| state.applied_at_seconds.is_some());
        if last.map(|state| state.name.as_str()) != Some(request.name.as_str()) {
            return Err(invalid("Only the last applied migration can be rolled back"));
        }
        let migration = request
            .migrations
            .iter()
            .find(|migration| migration.name == request.name)
            .unwrap();
        execute_statements(&mut transaction, &migration.down).await?;
        sqlx::query("DELETE FROM meta WHERE key=?")
            .bind(format!("{PREFIX}{}", request.name))
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        self.migration_status(pb::DatabaseMigrations {
            migrations: request.migrations,
        })
        .await
    }
}

async fn execute_statements(connection: &mut SqliteConnection, statements: &[String]) -> Result<()> {
    let mut budget = Budget::default();
    for sql in statements {
        let statement = pb::SqlStatement {
            sql: sql.clone(),
            ..Default::default()
        };
        run(connection, &statement, &[], false, &mut budget).await?;
    }
    Ok(())
}
