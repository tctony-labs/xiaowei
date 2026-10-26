use futures_util::{FutureExt, future::BoxFuture, future::Shared};
use std::{future::Future, sync::OnceLock};
use tokio::runtime::{Builder, Runtime};

use crate::{LocalErrorKind, MobileError, Result};

pub(crate) type Task<T> = Shared<BoxFuture<'static, Result<T>>>;

pub(crate) fn get() -> Result<&'static Runtime> {
    static RUNTIME: OnceLock<std::result::Result<Runtime, std::io::Error>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("xiaowei-mobile")
                .enable_all()
                .build()
        })
        .as_ref()
        .map_err(|_| MobileError::local(LocalErrorKind::Runtime, "无法初始化移动运行时"))
}

pub(crate) fn spawn<T, F>(work: F) -> Result<Task<T>>
where
    T: Clone + Send + Sync + 'static,
    F: Future<Output = Result<T>> + Send + 'static,
{
    let task = get()?.spawn(work);
    Ok(async move {
        task.await.map_err(|_| {
            log::error!("Mobile runtime task terminated unexpectedly");
            MobileError::local(LocalErrorKind::Runtime, "移动运行任务意外结束")
        })?
    }
    .boxed()
    .shared())
}
