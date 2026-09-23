//! Internal SQL request and result types. These are never sent through Gateway.

use xw_contracts::xiaowei::common::Empty;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SqlValue {
    pub kind: Option<sql_value::Kind>,
}

pub mod sql_value {
    use super::Empty;

    #[derive(Clone, Debug, PartialEq)]
    pub enum Kind {
        Null(Empty),
        Integer(i64),
        Real(f64),
        Text(String),
        Blob(Vec<u8>),
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SqlCellReference {
    pub step: u32,
    pub row: u32,
    pub column: u32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SqlParameter {
    pub source: Option<sql_parameter::Source>,
}

pub mod sql_parameter {
    use super::{SqlCellReference, SqlValue};

    #[derive(Clone, Debug, PartialEq)]
    pub enum Source {
        Literal(SqlValue),
        Cell(SqlCellReference),
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SqlStatement {
    pub sql: String,
    pub parameters: Vec<SqlParameter>,
    pub expected_rows: Option<u32>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SqlRow {
    pub cells: Vec<SqlValue>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SqlResult {
    pub columns: Vec<String>,
    pub rows: Vec<SqlRow>,
    pub affected_rows: u64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SqlTransaction {
    pub steps: Vec<SqlStatement>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SqlTransactionResult {
    pub results: Vec<SqlResult>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DatabaseMigration {
    pub name: String,
    pub up: Vec<String>,
    pub down: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DatabaseMigrations {
    pub migrations: Vec<DatabaseMigration>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DatabaseMigrationState {
    pub name: String,
    pub applied_at_seconds: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DatabaseMigrationStates {
    pub states: Vec<DatabaseMigrationState>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DatabaseRollback {
    pub migrations: Vec<DatabaseMigration>,
    pub name: String,
}
