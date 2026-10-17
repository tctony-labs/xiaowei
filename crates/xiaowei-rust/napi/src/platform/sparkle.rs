use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::Arc;
use xw_platform::sparkle;

type EventCallback = ThreadsafeFunction<String, (), String, napi::Status, false, true>;

#[napi]
pub struct SparkleUpdater {
    inner: Option<sparkle::SparkleUpdater>,
}

#[napi]
impl SparkleUpdater {
    #[napi(
        factory,
        ts_args_type = "frameworkPath: string, callback: (event: string) => void"
    )]
    pub fn open(framework_path: String, callback: Arc<EventCallback>) -> napi::Result<Self> {
        let inner = sparkle::SparkleUpdater::open(&framework_path, move |event| {
            let status = callback.call(event, ThreadsafeFunctionCallMode::NonBlocking);
            if status != napi::Status::Ok {
                eprintln!("Sparkle event callback failed: {status:?}");
            }
        })
        .map_err(napi::Error::from_reason)?;
        Ok(Self { inner: Some(inner) })
    }

    #[napi]
    pub fn check(&self, background: bool) -> napi::Result<()> {
        self.inner
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("Sparkle updater closed"))?
            .check(background)
            .map_err(napi::Error::from_reason)
    }

    #[napi]
    pub fn resume_install(&self) -> napi::Result<()> {
        self.inner
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("Sparkle updater closed"))?
            .resume_install()
            .map_err(napi::Error::from_reason)
    }

    #[napi]
    pub fn close(&mut self) {
        self.inner.take();
    }
}
