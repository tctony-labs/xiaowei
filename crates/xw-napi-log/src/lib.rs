//! Each native library installs its own Rust log sink; the host owns console/file output.
use log::{Log, Metadata, Record};
use std::sync::{OnceLock, RwLock};

pub struct Entry {
    pub level: String,
    pub target: String,
    pub message: String,
}

type Sink = Box<dyn Fn(Entry) + Send + Sync>;
static SINK: RwLock<Option<Sink>> = RwLock::new(None);
static INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();

struct Logger;
impl Log for Logger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= log::max_level()
            && (metadata.target().starts_with("xw_") || metadata.target().starts_with("xiaowei_"))
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        if let Ok(sink) = SINK.read() {
            if let Some(sink) = sink.as_ref() {
                sink(Entry {
                    level: record.level().as_str().to_lowercase(),
                    target: record.target().into(),
                    message: record.args().to_string(),
                });
            }
        }
    }

    fn flush(&self) {}
}

pub fn initialize(module: &str, development: bool, sink: impl Fn(Entry) + Send + Sync + 'static) -> Result<(), String> {
    INITIALIZED
        .get_or_init(|| log::set_logger(&Logger).map_err(|error| error.to_string()))
        .clone()?;
    *SINK.write().map_err(|_| "Native logger unavailable")? = Some(Box::new(sink));
    log::set_max_level(if development {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    });
    log::info!("Native logging initialized: {module}");
    Ok(())
}
