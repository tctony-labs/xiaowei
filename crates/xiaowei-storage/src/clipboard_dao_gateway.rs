use crate::{clipboard_dao::ClipboardDao, Error, Result};
use prost::{Message, Name};
use std::future::Future;
use std::sync::Arc;
use xw_gateway::{binding::Method, ErrorCode, GatewayError, InvokeRegistration};

use crate::gateway_binding::xiaowei_clipboard_clipboard_dao_service as methods;

pub fn registrations(dao: &Arc<ClipboardDao>) -> Vec<InvokeRegistration> {
    vec![
        handler(dao, &methods::CAPTURE, |s, r| async move { s.capture(r).await }),
        handler(dao, &methods::LIST, |s, r| async move { s.list(r).await }),
        handler(dao, &methods::SEARCH, |s, r| async move { s.search(r).await }),
        handler(dao, &methods::GET, |s, r| async move { s.get(r).await }),
        handler(dao, &methods::TOUCH, |s, r| async move { s.touch(r).await }),
        handler(
            dao,
            &methods::SET_FAVORITE,
            |s, r| async move { s.set_favorite(r).await },
        ),
        handler(dao, &methods::SET_REMARK, |s, r| async move { s.set_remark(r).await }),
        handler(
            dao,
            &methods::SET_CATEGORY,
            |s, r| async move { s.set_category(r).await },
        ),
        handler(dao, &methods::CATEGORIES, |s, r| async move { s.categories(r).await }),
        handler(
            dao,
            &methods::SAVE_CATEGORY,
            |s, r| async move { s.save_category(r).await },
        ),
        handler(dao, &methods::DELETE_CATEGORY, |s, r| async move {
            s.delete_category(r).await
        }),
        handler(dao, &methods::EDIT_TEXT, |s, r| async move { s.edit_text(r).await }),
        handler(dao, &methods::DELETE, |s, r| async move { s.delete(r).await }),
        handler(dao, &methods::PURGE_ORDINARY_BATCH, |s, r| async move {
            s.purge_ordinary_batch(r).await
        }),
        handler(dao, &methods::CLEAR_HISTORY_BATCH, |s, r| async move {
            s.clear_history_batch(r).await
        }),
        handler(dao, &methods::HASH_REFERENCED, |s, r| async move {
            s.hash_referenced(r).await
        }),
    ]
}

fn handler<Req, Res, F, Fut>(dao: &Arc<ClipboardDao>, method: &Method<Req, Res>, work: F) -> InvokeRegistration
where
    Req: Message + Default + Name + 'static,
    Res: Message + Default + Name + 'static,
    F: Fn(Arc<ClipboardDao>, Req) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Res>> + Send + 'static,
{
    let dao = dao.clone();
    method.handler(move |request, _| {
        let future = work(dao.clone(), request);
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
