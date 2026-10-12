//! Owned Sparkle controller. All calls, including release, belong on the macOS main thread.

#[cfg(target_os = "macos")]
pub use crate::macos::sparkle::SparkleUpdater;

#[cfg(not(target_os = "macos"))]
pub struct SparkleUpdater;

#[cfg(not(target_os = "macos"))]
impl SparkleUpdater {
    pub fn open(_framework: &str, _event: impl Fn(String) + 'static) -> Result<Self, String> {
        Err("Sparkle is only supported on macOS".into())
    }

    pub fn check(&self, _background: bool) -> Result<(), String> {
        Err("Sparkle is only supported on macOS".into())
    }

    pub fn resume_install(&self) -> Result<(), String> {
        Err("Sparkle is only supported on macOS".into())
    }
}
