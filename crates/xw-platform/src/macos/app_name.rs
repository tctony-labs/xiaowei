//! macOS 下用 `NSFileManager.displayNameAtPath:` 取本地化显示名。

use std::path::Path;

use objc2_foundation::{NSFileManager, NSString};

/// 取 `path` 的本地化显示名（Finder 展示名），去掉 bundle 扩展名；取不到返回 `None`。
pub fn localized_name(path: &Path) -> Option<String> {
    let p = path.to_str()?;
    let fm = NSFileManager::defaultManager();
    let ns_path = NSString::from_str(p);
    let name = fm.displayNameAtPath(&ns_path).to_string();

    // displayName 一般已隐藏扩展名，个别情况仍带，统一剥掉。
    let name = name
        .strip_suffix(".app")
        .or_else(|| name.strip_suffix(".prefPane"))
        .unwrap_or(&name)
        .to_string();

    (!name.trim().is_empty()).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_app_extension() {
        let name = localized_name(Path::new("/System/Library/CoreServices/Finder.app"));
        assert!(name.is_some());
        let name = name.unwrap();
        assert!(!name.ends_with(".app"), "扩展名应被剥掉: {name}");
        assert!(!name.is_empty());
    }
}
