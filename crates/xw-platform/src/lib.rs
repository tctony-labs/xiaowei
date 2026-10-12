//! 按需迁入的系统能力，供内部功能 crate 复用。
pub mod app_icon;
pub mod app_name;
pub mod focus;
pub mod sparkle;

#[cfg(target_os = "macos")]
mod macos {
    pub mod app_name;
    pub mod focus;
    pub mod sparkle;
}

pub mod appearance;
