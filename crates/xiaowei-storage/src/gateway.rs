use crate::{invalid, Database, Error, Result};
use prost::{Message, Name};
use std::future::Future;
use std::sync::Arc;
use xw_gateway::{binding::Method, ErrorCode, GatewayError, InvokeRegistration};

use crate::gateway_binding::xiaowei_storage_key_value_service as kv;

pub fn registrations(database: &Arc<Database>) -> Vec<InvokeRegistration> {
    vec![
        handler(database, &kv::GET, |db, request| async move {
            public_key(&request.key)?;
            db.meta_get(request).await
        }),
        handler(database, &kv::SET, |db, request| async move {
            public_key(&request.key)?;
            db.meta_set(request).await
        }),
        handler(database, &kv::DELETE, |db, request| async move {
            public_key(&request.key)?;
            db.meta_delete(request).await
        }),
        handler(database, &kv::LIST, |db, request| async move {
            let mut result = db.meta_list(request).await?;
            result.entries.retain(|entry| !reserved(&entry.key));
            Ok(result)
        }),
    ]
}

fn reserved(key: &str) -> bool {
    key.starts_with("setting.") || key.starts_with("migration_v2.")
}

fn public_key(key: &str) -> Result<()> {
    if reserved(key) {
        return Err(invalid("Key is reserved for internal Storage state"));
    }
    Ok(())
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
