//! macOS 应用包图标读取，沿用旧版 NSWorkspace 路径（支持 Assets.car 和 icns）。
use std::path::Path;

pub fn read_app_icon(path: &Path) -> Option<Vec<u8>> {
    if !path.is_dir() || path.extension()?.to_str()? != "app" {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::autoreleasepool;
        use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
        use objc2_foundation::{NSDictionary, NSSize, NSString};
        autoreleasepool(|_| unsafe {
            let image = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path.to_str()?));
            image.setSize(NSSize {
                width: 128.0,
                height: 128.0,
            });
            let tiff = image.TIFFRepresentation()?;
            let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
            let png = rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())?;
            Some(png.to_vec())
        })
    }
    #[cfg(not(target_os = "macos"))]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn finder_and_safari_produce_distinct_pngs() {
        let finder = read_app_icon(Path::new("/System/Library/CoreServices/Finder.app")).unwrap();
        assert!(finder.starts_with(b"\x89PNG\r\n\x1a\n"));
        let safari_path = Path::new("/Applications/Safari.app");
        if safari_path.exists() {
            let safari = read_app_icon(safari_path).unwrap();
            assert!(safari.starts_with(b"\x89PNG\r\n\x1a\n"));
            assert_ne!(
                finder, safari,
                "application icons must not all be a MIME type placeholder"
            );
        }
    }

    #[test]
    fn missing_bundle_has_no_icon() {
        assert!(read_app_icon(Path::new("/no/such/bundle.app")).is_none());
    }
}
