use std::path::Path;

/// 与 Finder 一致的本地化显示名；不支持的平台由调用方回退到应用清单名称。
pub fn localized_name(path: &Path) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        crate::macos::app_name::localized_name(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        None
    }
}
