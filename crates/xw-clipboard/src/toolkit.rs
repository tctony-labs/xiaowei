use crate::{ClipboardBackend, ClipboardData, Result};

pub struct SystemClipboard;

impl ClipboardBackend for SystemClipboard {
    fn paste(&mut self) -> Result<bool> {
        crate::send_paste_shortcut()
    }

    fn request_paste_permission(&mut self) {
        crate::request_accessibility_permission();
    }

    fn change_count(&mut self) -> Result<i64> {
        #[cfg(target_os = "macos")]
        return Ok(objc2::rc::autoreleasepool(|_| {
            macos::get_clipboard_change_count()
        }));
        #[cfg(not(target_os = "macos"))]
        Err("Clipboard monitoring is currently supported on macOS only".into())
    }

    fn read(&mut self) -> Result<Option<ClipboardData>> {
        #[cfg(target_os = "macos")]
        return objc2::rc::autoreleasepool(|_| macos::read_clipboard()).map_err(Into::into);
        #[cfg(not(target_os = "macos"))]
        Err("Clipboard is currently supported on macOS only".into())
    }

    fn write(&mut self, data: &ClipboardData) -> Result<()> {
        #[cfg(target_os = "macos")]
        return objc2::rc::autoreleasepool(|_| match data {
            ClipboardData::Text(text) => macos::write_text(text),
            ClipboardData::Image { data, .. } => macos::write_image_from_png(data),
            ClipboardData::Files(paths) => {
                if paths
                    .iter()
                    .any(|path| !std::path::Path::new(path).exists())
                {
                    return Err("A clipboard file no longer exists".into());
                }
                macos::write_file_urls(&paths.iter().map(String::as_str).collect::<Vec<_>>())
            }
        })
        .map_err(Into::into);
        #[cfg(not(target_os = "macos"))]
        {
            let _ = data;
            Err("Clipboard is currently supported on macOS only".into())
        }
    }
}

// Adapted from the old xw-domain clipboard toolkit; no Tauri or application state dependencies.
#[cfg(target_os = "macos")]
mod macos {
    use crate::ClipboardData;
    use core_graphics::display::CGDisplay;
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use image::ImageFormat;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{
        NSBitmapImageRep, NSPasteboard, NSPasteboardItem, NSPasteboardTypePNG,
        NSPasteboardTypeTIFF, NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSNumber, NSString, NSURL};
    use objc2_image_io::{kCGImagePropertyDPIHeight, kCGImagePropertyDPIWidth, CGImageSource};
    use std::io::Cursor;

    const WECHAT_SCREENSHOT_TYPE: &str = "com.trolltech.anymime.WeChatScreenshotFormat";

    pub fn read_clipboard() -> Result<Option<ClipboardData>, String> {
        let pasteboard = NSPasteboard::generalPasteboard();
        // Finder also publishes filenames as text, so file URLs take priority.
        if let Some(files) = read_file_urls(&pasteboard) {
            return Ok(Some(files));
        }
        let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
        match clipboard.get_text() {
            Ok(text) if !text.is_empty() => return Ok(Some(ClipboardData::Text(text))),
            Ok(_) | Err(arboard::Error::ContentNotAvailable) => {}
            Err(error) => return Err(error.to_string()),
        }
        read_image_from(&pasteboard, display_scale_at_pointer)
    }

    fn read_file_urls(pasteboard: &NSPasteboard) -> Option<ClipboardData> {
        let file_type = NSString::from_str("public.file-url");
        let mut paths = Vec::new();
        for item in pasteboard.pasteboardItems()? {
            if let Some(value) = item.stringForType(&file_type) {
                if let Some(url) = NSURL::URLWithString_encodingInvalidCharacters(&value, false) {
                    if let Some(path) = url
                        .to_file_path()
                        .and_then(|path| path.to_str().map(str::to_owned))
                    {
                        paths.push(path);
                    }
                }
            }
        }
        if paths.is_empty() {
            None
        } else {
            Some(ClipboardData::Files(paths))
        }
    }

    fn read_image_from(
        pasteboard: &NSPasteboard,
        screenshot_scale: impl Fn() -> Option<f64>,
    ) -> Result<Option<ClipboardData>, String> {
        // Prefer PNG when offered, since it carries its pixel density without TIFF conversion.
        let formats = unsafe {
            [
                (NSPasteboardTypePNG, ImageFormat::Png),
                (NSPasteboardTypeTIFF, ImageFormat::Tiff),
            ]
        };
        let mut result = Ok(None);
        for (pasteboard_type, format) in formats {
            if let Some(data) = pasteboard.dataForType(pasteboard_type) {
                result = read_image_data(&data, format, || {
                    wechat_screenshot_density(pasteboard, &screenshot_scale)
                })
                .map(Some);
                if result.is_ok() {
                    break;
                }
            }
        }
        result
    }

    fn read_image_data(
        data: &NSData,
        format: ImageFormat,
        fallback_density: impl FnOnce() -> Option<png::PixelDimensions>,
    ) -> Result<ClipboardData, String> {
        // The retained pasteboard data is immutable for the duration of the decode.
        let bytes = unsafe { data.as_bytes_unchecked() };
        let image = image::load_from_memory_with_format(bytes, format)
            .map_err(|error| error.to_string())?
            .into_rgba8();
        let (width, height) = image.dimensions();
        let density = if format == ImageFormat::Png {
            png::Decoder::new(Cursor::new(bytes))
                .read_info()
                .ok()
                .and_then(|reader| reader.info().pixel_dims)
        } else {
            tiff_pixel_density(data)
        }
        .or_else(fallback_density);
        log::trace!(
            "Clipboard image decoded: format={format:?} size={width}x{height} density={density:?}"
        );
        let data = encode_png(image.as_raw(), width, height, density)?;
        Ok(ClipboardData::Image {
            data,
            width,
            height,
        })
    }

    fn tiff_pixel_density(data: &NSData) -> Option<png::PixelDimensions> {
        let source = unsafe { CGImageSource::with_data(data.as_ref(), None) }?;
        let properties = unsafe { source.properties_at_index(0, None) }?;
        // ImageIO returns a property list with Objective-C string keys and object values.
        let properties: &NSDictionary = unsafe { properties.cast_unchecked() }.as_ref();
        let pixels_per_meter = |key: &NSString| {
            let dpi = properties.objectForKey(key)?.downcast::<NSNumber>().ok()?;
            dpi_to_pixels_per_meter(dpi.doubleValue())
        };
        Some(png::PixelDimensions {
            xppu: pixels_per_meter(unsafe { kCGImagePropertyDPIWidth }.as_ref())?,
            yppu: pixels_per_meter(unsafe { kCGImagePropertyDPIHeight }.as_ref())?,
            unit: png::Unit::Meter,
        })
    }

    fn wechat_screenshot_density(
        pasteboard: &NSPasteboard,
        screenshot_scale: impl FnOnce() -> Option<f64>,
    ) -> Option<png::PixelDimensions> {
        let marker = NSString::from_str(WECHAT_SCREENSHOT_TYPE);
        if !pasteboard.types()?.containsObject(&marker) {
            return None;
        }
        // WeChat supplies pixels and the screenshot marker, but no source display ID.
        let scale = screenshot_scale()?;
        if scale <= 1.0 {
            return None;
        }
        // AppKit's logical image size uses 72 points per inch.
        let ppm = dpi_to_pixels_per_meter(72.0 * scale)?;
        log::debug!("Applying WeChat screenshot display scale: {scale}");
        Some(png::PixelDimensions {
            xppu: ppm,
            yppu: ppm,
            unit: png::Unit::Meter,
        })
    }

    fn display_scale_at_pointer() -> Option<f64> {
        let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
        let point = CGEvent::new(source).ok()?.location();
        let mode = CGDisplay::active_displays()
            .ok()?
            .into_iter()
            .map(CGDisplay::new)
            .find(|display| display.bounds().contains(&point))?
            .display_mode()?;
        Some(mode.pixel_width() as f64 / mode.width() as f64)
    }

    fn dpi_to_pixels_per_meter(dpi: f64) -> Option<u32> {
        let ppm = (dpi / 0.0254).round();
        (1.0..=f64::from(u32::MAX))
            .contains(&ppm)
            .then_some(ppm as u32)
    }

    fn encode_png(
        rgba: &[u8],
        width: u32,
        height: u32,
        density: Option<png::PixelDimensions>,
    ) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_pixel_dims(density);
            let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
            writer
                .write_image_data(rgba)
                .map_err(|error| error.to_string())?;
        }
        Ok(bytes)
    }

    pub fn write_text(text: &str) -> Result<(), String> {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(text))
            .map_err(|error| error.to_string())
    }

    pub fn write_image_from_png(data: &[u8]) -> Result<(), String> {
        write_image_to(&NSPasteboard::generalPasteboard(), data)
    }

    fn write_image_to(pasteboard: &NSPasteboard, data: &[u8]) -> Result<(), String> {
        let png = NSData::with_bytes(data);
        let tiff = NSBitmapImageRep::imageRepWithData(&png)
            .and_then(|image| image.TIFFRepresentation())
            .ok_or("Cannot convert clipboard image to TIFF")?;
        let item = NSPasteboardItem::new();
        if !item.setData_forType(&png, unsafe { NSPasteboardTypePNG })
            || !item.setData_forType(&tiff, unsafe { NSPasteboardTypeTIFF })
        {
            return Err("Cannot encode clipboard image".into());
        }
        let object: &ProtocolObject<dyn NSPasteboardWriting> = ProtocolObject::from_ref(&*item);
        pasteboard.clearContents();
        if pasteboard.writeObjects(&NSArray::from_slice(&[object])) {
            Ok(())
        } else {
            Err("Cannot write clipboard image".into())
        }
    }

    pub fn write_file_urls(paths: &[&str]) -> Result<(), String> {
        write_file_urls_to(&NSPasteboard::generalPasteboard(), paths)
    }

    fn write_file_urls_to(pasteboard: &NSPasteboard, paths: &[&str]) -> Result<(), String> {
        let file_type = NSString::from_str("public.file-url");
        let mut items = Vec::new();
        for path in paths {
            let url = NSURL::from_file_path(path).ok_or("Invalid file path")?;
            let value = url.absoluteString().ok_or("Invalid file URL")?;
            let item = NSPasteboardItem::new();
            if !item.setString_forType(&value, &file_type) {
                return Err("Cannot encode file URL".into());
            }
            items.push(item);
        }
        if items.is_empty() {
            return Err("No file paths".into());
        }
        let refs: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = items
            .iter()
            .map(|item| ProtocolObject::from_ref(&**item))
            .collect();
        let objects = NSArray::from_slice(&refs);
        pasteboard.clearContents();
        if pasteboard.writeObjects(&objects) {
            Ok(())
        } else {
            Err("Cannot write file URLs".into())
        }
    }

    pub fn get_clipboard_change_count() -> i64 {
        NSPasteboard::generalPasteboard().changeCount() as i64
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn image_copy_preserves_pixels_and_optional_density() {
            objc2::rc::autoreleasepool(|_| {
                let pasteboard = NSPasteboard::pasteboardWithUniqueName();
                let pixels = [255, 0, 0, 255, 0, 255, 0, 128];
                let density = png::PixelDimensions {
                    xppu: 5669,
                    yppu: 5670,
                    unit: png::Unit::Meter,
                };
                for density in [Some(density), None] {
                    let png = encode_png(&pixels, 2, 1, density).unwrap();
                    write_image_to(&pasteboard, &png).unwrap();
                    assert!(pasteboard
                        .dataForType(unsafe { NSPasteboardTypeTIFF })
                        .is_some());
                    let captured = read_image_from(&pasteboard, || Some(2.0)).unwrap();
                    assert_eq!(
                        captured,
                        Some(ClipboardData::Image {
                            data: png,
                            width: 2,
                            height: 1
                        })
                    );
                }
                pasteboard.clearContents();
            });
        }

        #[test]
        fn tiff_capture_preserves_density_or_recovers_wechat_screenshot_scale() {
            objc2::rc::autoreleasepool(|_| {
                let pasteboard = NSPasteboard::pasteboardWithUniqueName();
                let pixels = [255, 0, 0, 255, 0, 255, 0, 255];
                let retina = png::PixelDimensions {
                    xppu: 5669,
                    yppu: 5669,
                    unit: png::Unit::Meter,
                };
                let cases = [
                    (Some(retina), false, 2.0, Some(retina)),
                    (None, false, 2.0, None),
                    (Some(retina), true, 1.0, Some(retina)),
                    (None, true, 1.0, None),
                    (None, true, 2.0, Some(retina)),
                ];
                for (source_density, wechat, display_scale, expected_density) in cases {
                    let png = encode_png(&pixels, 2, 1, source_density).unwrap();
                    let tiff = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(&png))
                        .unwrap()
                        .TIFFRepresentation()
                        .unwrap();
                    let item = NSPasteboardItem::new();
                    assert!(item.setData_forType(&tiff, unsafe { NSPasteboardTypeTIFF }));
                    if wechat {
                        let marker = NSString::from_str(WECHAT_SCREENSHOT_TYPE);
                        assert!(item.setData_forType(&NSData::with_bytes(b"X"), &marker));
                    }
                    let object: &ProtocolObject<dyn NSPasteboardWriting> =
                        ProtocolObject::from_ref(&*item);
                    pasteboard.clearContents();
                    assert!(pasteboard.writeObjects(&NSArray::from_slice(&[object])));
                    let Some(ClipboardData::Image {
                        data,
                        width,
                        height,
                    }) = read_image_from(&pasteboard, || Some(display_scale)).unwrap()
                    else {
                        panic!("Expected a captured TIFF image");
                    };
                    assert_eq!((width, height), (2, 1));
                    assert_eq!(data, encode_png(&pixels, 2, 1, expected_density).unwrap());
                    let size = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(&data))
                        .unwrap()
                        .size();
                    let expected_size = if expected_density.is_some() {
                        (1.0, 0.5)
                    } else {
                        (2.0, 1.0)
                    };
                    assert_eq!((size.width, size.height), expected_size);
                }
                pasteboard.clearContents();
            });
        }

        #[test]
        fn multiple_file_urls_round_trip_on_a_private_pasteboard() {
            objc2::rc::autoreleasepool(|_| {
                let pasteboard = NSPasteboard::pasteboardWithUniqueName();
                let paths = ["/tmp/a,b.txt", "/tmp/中文 file.txt"];
                write_file_urls_to(&pasteboard, &paths).unwrap();
                let actual = read_file_urls(&pasteboard);
                pasteboard.clearContents();
                assert_eq!(
                    actual,
                    Some(ClipboardData::Files(
                        paths.iter().map(|path| path.to_string()).collect()
                    ))
                );
            });
        }
    }
}
