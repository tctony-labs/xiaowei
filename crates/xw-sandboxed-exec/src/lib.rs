//! Process sandbox policies, independent of Agent state and process ownership.
mod policy;
pub use policy::{FileAccess, SandboxPolicy, WritableRoot};

#[cfg(target_os = "macos")]
pub mod seatbelt;
