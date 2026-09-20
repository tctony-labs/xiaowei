// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_storage_database_service {
    pub const QUERY: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::SqlStatement, xw_contracts::xiaowei::storage::SqlResult> =
        xw_gateway::binding::Method::new("xiaowei.storage.Database.Query", xw_gateway::MethodKind::Unary);
    pub const EXECUTE: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::SqlStatement, xw_contracts::xiaowei::storage::SqlResult> =
        xw_gateway::binding::Method::new("xiaowei.storage.Database.Execute", xw_gateway::MethodKind::Unary);
    pub const TRANSACTION: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::SqlTransaction, xw_contracts::xiaowei::storage::SqlTransactionResult> =
        xw_gateway::binding::Method::new("xiaowei.storage.Database.Transaction", xw_gateway::MethodKind::Unary);
    pub const APPLY_MIGRATIONS: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::DatabaseMigrations, xw_contracts::xiaowei::storage::DatabaseMigrationStates> =
        xw_gateway::binding::Method::new("xiaowei.storage.Database.ApplyMigrations", xw_gateway::MethodKind::Unary);
    pub const MIGRATION_STATUS: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::DatabaseMigrations, xw_contracts::xiaowei::storage::DatabaseMigrationStates> =
        xw_gateway::binding::Method::new("xiaowei.storage.Database.MigrationStatus", xw_gateway::MethodKind::Unary);
    pub const ROLLBACK: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::DatabaseRollback, xw_contracts::xiaowei::storage::DatabaseMigrationStates> =
        xw_gateway::binding::Method::new("xiaowei.storage.Database.Rollback", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_storage_meta_service {
    pub const GET: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::MetaKey, xw_contracts::xiaowei::storage::MetaValue> =
        xw_gateway::binding::Method::new("xiaowei.storage.Meta.Get", xw_gateway::MethodKind::Unary);
    pub const SET: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::MetaEntry, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.storage.Meta.Set", xw_gateway::MethodKind::Unary);
    pub const DELETE: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::MetaKey, xw_contracts::xiaowei::storage::MetaDeleted> =
        xw_gateway::binding::Method::new("xiaowei.storage.Meta.Delete", xw_gateway::MethodKind::Unary);
    pub const LIST: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::MetaPrefix, xw_contracts::xiaowei::storage::MetaEntries> =
        xw_gateway::binding::Method::new("xiaowei.storage.Meta.List", xw_gateway::MethodKind::Unary);
}
