use crate::Result;
use xw_contracts::xiaowei::storage as pb;
use xw_gateway::invoke::Client;

tokio::task_local! {
    pub(crate) static CALLER: Client;
}

#[allow(dead_code)]
#[path = "storage_bindings.rs"]
mod bindings;
use bindings::xiaowei_storage_database_service as methods;

#[derive(Clone)]
pub struct DatabaseClient(pub Client);

impl DatabaseClient {
    fn client(&self) -> Client {
        CALLER.try_with(Clone::clone).unwrap_or_else(|_| self.0.clone())
    }

    pub async fn initialize(&self) -> Result<()> {
        methods::APPLY_MIGRATIONS
            .call(&self.client(), crate::migrations::registry())
            .await?;
        Ok(())
    }

    pub async fn query(&self, sql: &str, parameters: Vec<pb::SqlParameter>) -> Result<Vec<Row>> {
        let result = methods::QUERY.call(&self.client(), statement(sql, parameters)).await?;
        Ok(result.rows.into_iter().map(Row).collect())
    }

    pub async fn execute(&self, sql: &str, parameters: Vec<pb::SqlParameter>) -> Result<u64> {
        Ok(methods::EXECUTE
            .call(&self.client(), statement(sql, parameters))
            .await?
            .affected_rows)
    }

    pub async fn transaction(&self, steps: Vec<pb::SqlStatement>) -> Result<Vec<Vec<Row>>> {
        let result = methods::TRANSACTION
            .call(&self.client(), pb::SqlTransaction { steps })
            .await?;
        Ok(result
            .results
            .into_iter()
            .map(|result| result.rows.into_iter().map(Row).collect())
            .collect())
    }
}

pub fn statement(sql: &str, parameters: Vec<pb::SqlParameter>) -> pb::SqlStatement {
    pb::SqlStatement {
        sql: sql.into(),
        parameters,
        expected_rows: None,
    }
}

pub fn reference(step: u32, column: u32) -> pb::SqlParameter {
    pb::SqlParameter {
        source: Some(pb::sql_parameter::Source::Cell(pb::SqlCellReference {
            step,
            row: 0,
            column,
        })),
    }
}

pub fn value(input: impl IntoValue) -> pb::SqlParameter {
    pb::SqlParameter {
        source: Some(pb::sql_parameter::Source::Literal(pb::SqlValue {
            kind: Some(input.into_value()),
        })),
    }
}

pub trait IntoValue {
    fn into_value(self) -> pb::sql_value::Kind;
}

impl IntoValue for i64 {
    fn into_value(self) -> pb::sql_value::Kind {
        pb::sql_value::Kind::Integer(self)
    }
}

impl IntoValue for u32 {
    fn into_value(self) -> pb::sql_value::Kind {
        pb::sql_value::Kind::Integer(self.into())
    }
}

impl IntoValue for bool {
    fn into_value(self) -> pb::sql_value::Kind {
        pb::sql_value::Kind::Integer(self.into())
    }
}

impl IntoValue for &str {
    fn into_value(self) -> pb::sql_value::Kind {
        pb::sql_value::Kind::Text(self.into())
    }
}

impl IntoValue for String {
    fn into_value(self) -> pb::sql_value::Kind {
        pb::sql_value::Kind::Text(self)
    }
}

impl IntoValue for &String {
    fn into_value(self) -> pb::sql_value::Kind {
        pb::sql_value::Kind::Text(self.clone())
    }
}

impl<T: IntoValue> IntoValue for Option<T> {
    fn into_value(self) -> pb::sql_value::Kind {
        self.map(IntoValue::into_value)
            .unwrap_or_else(|| pb::sql_value::Kind::Null(Default::default()))
    }
}

pub struct Row(pub pb::SqlRow);
impl Row {
    pub fn get<T: FromValue>(&self, index: usize) -> Result<T> {
        T::from_value(
            self.0
                .cells
                .get(index)
                .and_then(|cell| cell.kind.as_ref())
                .ok_or("Missing SQL cell")?,
        )
    }
}

pub trait FromValue: Sized {
    fn from_value(value: &pb::sql_value::Kind) -> Result<Self>;
}

impl FromValue for String {
    fn from_value(value: &pb::sql_value::Kind) -> Result<Self> {
        match value {
            pb::sql_value::Kind::Text(text) => Ok(text.clone()),
            _ => Err("Expected SQL text".into()),
        }
    }
}

impl FromValue for i64 {
    fn from_value(value: &pb::sql_value::Kind) -> Result<Self> {
        match value {
            pb::sql_value::Kind::Integer(n) => Ok(*n),
            _ => Err("Expected SQL integer".into()),
        }
    }
}

impl FromValue for u32 {
    fn from_value(value: &pb::sql_value::Kind) -> Result<Self> {
        Ok(i64::from_value(value)?.try_into()?)
    }
}

impl FromValue for bool {
    fn from_value(value: &pb::sql_value::Kind) -> Result<Self> {
        Ok(i64::from_value(value)? != 0)
    }
}

impl<T: FromValue> FromValue for Option<T> {
    fn from_value(value: &pb::sql_value::Kind) -> Result<Self> {
        if matches!(value, pb::sql_value::Kind::Null(_)) {
            Ok(None)
        } else {
            T::from_value(value).map(Some)
        }
    }
}
