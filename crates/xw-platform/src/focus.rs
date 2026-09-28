//! Explicitly owned focus snapshots; no process-global focus history.

#[cfg(target_os = "macos")]
pub use crate::macos::focus::{frontmost_process, FocusSnapshot};

#[cfg(not(target_os = "macos"))]
pub fn frontmost_process() -> Option<u32> {
    None
}

#[cfg(not(target_os = "macos"))]
pub struct FocusSnapshot;

#[cfg(not(target_os = "macos"))]
impl FocusSnapshot {
    pub fn capture() -> Option<Self> {
        None
    }

    pub fn process_id(&self) -> u32 {
        0
    }

    pub fn restore(&mut self, _expected_process: u32) -> bool {
        false
    }

    pub fn is_frontmost(&self) -> bool {
        false
    }
}
