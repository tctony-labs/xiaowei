use crate::{Database, Error, Result};
use prost::{Message, Name};
use std::future::Future;
use std::sync::Arc;
use xw_gateway::{binding::Method, ErrorCode, GatewayError, InvokeRegistration};

#[allow(dead_code)]
#[path = "gateway_bindings.rs"]
pub mod bindings;
use bindings::xiaowei_storage_database_service as methods;
use bindings::xiaowei_storage_meta_service as meta;

pub fn registrations(database: &Arc<Database>) -> Vec<InvokeRegistration> {
    vec![
        handler(
            database,
            &meta::GET,
            |db, request| async move { db.meta_get(request).await },
        ),
        handler(
            database,
            &meta::SET,
            |db, request| async move { db.meta_set(request).await },
        ),
        handler(database, &meta::DELETE, |db, request| async move {
            db.meta_delete(request).await
        }),
        handler(database, &meta::LIST, |db, request| async move {
            db.meta_list(request).await
        }),
        handler(database, &methods::QUERY, |db, request| async move {
            db.query(request).await
        }),
        handler(database, &methods::EXECUTE, |db, request| async move {
            db.execute(request).await
        }),
        handler(database, &methods::TRANSACTION, |db, request| async move {
            db.transaction(request).await
        }),
        handler(database, &methods::APPLY_MIGRATIONS, |db, request| async move {
            db.apply_migrations(request).await
        }),
        handler(database, &methods::MIGRATION_STATUS, |db, request| async move {
            db.migration_status(request).await
        }),
        handler(database, &methods::ROLLBACK, |db, request| async move {
            db.rollback(request).await
        }),
    ]
}

fn handler<Req, Res, F, Fut>(database: &Arc<Database>, method: &Method<Req, Res>, work: F) -> InvokeRegistration
where
    Req: Message + Default + Name + 'static,
    Res: Message + Default + Name + 'static,
    F: Fn(Arc<Database>, Req) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Res>> + Send + 'static,
{
    let database = database.clone();
    method.handler(move |request, _| {
        let future = work(database.clone(), request);
        async move {
            future.await.map_err(|error| {
                let code = match error {
                    Error::Invalid(_) => ErrorCode::InvalidArgument,
                    _ => ErrorCode::HandlerError,
                };
                GatewayError::new(code, error.to_string())
            })
        }
    })
}
