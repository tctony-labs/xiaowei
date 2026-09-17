use log::{Log, Metadata, Record};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::{Arc, OnceLock, RwLock};

#[napi(object)]
pub struct NativeLogEntry {
    pub level: String,
    pub target: String,
    pub message: String,
}

type LogCallback = ThreadsafeFunction<NativeLogEntry, (), NativeLogEntry, napi::Status, false, true, 1024>;
static CALLBACK: RwLock<Option<Arc<LogCallback>>> = RwLock::new(None);
static INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();

struct NativeLogger;

impl Log for NativeLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= log::max_level()
            && (metadata.target().starts_with("xw_") || metadata.target().starts_with("xiaowei_"))
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        if let Ok(callback) = CALLBACK.read() {
            if let Some(callback) = callback.as_ref() {
                let status = callback.call(
                    NativeLogEntry {
                        level: record.level().as_str().to_lowercase(),
                        target: record.target().into(),
                        message: record.args().to_string(),
                    },
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
                if status == napi::Status::QueueFull {
                    eprintln!("Native log queue full; dropped a log entry");
                }
            }
        }
    }

    fn flush(&self) {}
}

#[napi(ts_args_type = "development: boolean, callback: (entry: NativeLogEntry) => void")]
pub fn initialize_logging(development: bool, callback: Arc<LogCallback>) -> napi::Result<()> {
    INITIALIZED
        .get_or_init(|| log::set_logger(&NativeLogger).map_err(|error| error.to_string()))
        .clone()
        .map_err(napi::Error::from_reason)?;
    *CALLBACK
        .write()
        .map_err(|_| napi::Error::from_reason("Native logger unavailable"))? = Some(callback);
    log::set_max_level(if development {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    });
    log::info!("Native logging initialized");
    Ok(())
}
