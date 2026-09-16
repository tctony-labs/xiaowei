//! 各平台默认 Chrome 书签文件定位。
//!
//! 只覆盖 Chrome 稳定版 Default profile；找不到时返回 `None`，由调用方决定降级行为。

use std::path::PathBuf;

/// 返回当前平台 Chrome 默认 profile 的 `Bookmarks` 文件路径（不校验是否存在）。
pub fn default_chrome_bookmarks_path() -> Option<PathBuf> {
    let base = chrome_user_data_dir()?;
    Some(base.join("Default").join("Bookmarks"))
}

#[cfg(target_os = "macos")]
fn chrome_user_data_dir() -> Option<PathBuf> {
    // ~/Library/Application Support/Google/Chrome
    dirs::config_dir().map(|d| d.join("Google").join("Chrome"))
}

#[cfg(target_os = "windows")]
fn chrome_user_data_dir() -> Option<PathBuf> {
    // %LOCALAPPDATA%\Google\Chrome\User Data
    dirs::data_local_dir().map(|d| d.join("Google").join("Chrome").join("User Data"))
}

#[cfg(target_os = "linux")]
fn chrome_user_data_dir() -> Option<PathBuf> {
    // ~/.config/google-chrome
    dirs::config_dir().map(|d| d.join("google-chrome"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn chrome_user_data_dir() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_ends_with_default_bookmarks() {
        // 在有 home 的环境下应能拼出路径；CI 上 dirs 也能返回。
        if let Some(p) = default_chrome_bookmarks_path() {
            assert!(p.ends_with("Default/Bookmarks") || p.ends_with("Default\\Bookmarks"));
        }
    }
}
