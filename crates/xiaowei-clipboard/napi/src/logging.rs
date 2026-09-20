use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::Arc;

#[napi(object)]
pub struct NativeLogEntry {
    pub level: String,
    pub target: String,
    pub message: String,
    pub file: Option<String>,
    pub line: Option<u32>,
}

type LogCallback = ThreadsafeFunction<NativeLogEntry, (), NativeLogEntry, napi::Status, false, true, 1024>;

#[napi(ts_args_type = "development: boolean, callback: (entry: NativeLogEntry) => void")]
pub fn initialize_logging(development: bool, callback: Arc<LogCallback>) -> napi::Result<()> {
    xw_napi_log::initialize("xiaowei-clipboard", development, move |entry| {
        let status = callback.call(
            NativeLogEntry {
                level: entry.level,
                target: entry.target,
                message: entry.message,
                file: entry.file,
                line: entry.line,
            },
            ThreadsafeFunctionCallMode::NonBlocking,
        );
        if status == napi::Status::QueueFull {
            eprintln!("Native log queue full; dropped a log entry");
        }
    })
    .map_err(napi::Error::from_reason)
}
