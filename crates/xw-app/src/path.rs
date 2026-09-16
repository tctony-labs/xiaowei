//! 各平台默认扫描目录（当前主要面向 macOS）。

use std::path::PathBuf;

/// 默认应用扫描目录。
pub fn application_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Library/CoreServices/Applications"),
    ];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join("Applications"));
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_core_services_applications() {
        assert!(application_dirs().contains(&PathBuf::from("/System/Library/CoreServices/Applications")));
    }
}
