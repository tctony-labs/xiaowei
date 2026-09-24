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
        return Ok(objc2::rc::autoreleasepool(|_| macos::get_clipboard_change_count()));
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
                if paths.iter().any(|path| !std::path::Path::new(path).exists()) {
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
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    pub fn read_clipboard() -> Result<Option<ClipboardData>, String> {
        // Finder also publishes filenames as text, so file URLs take priority.
        if let Some(files) = read_file_urls(&NSPasteboard::generalPasteboard()) {
            return Ok(Some(files));
        }
        let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
        match clipboard.get_text() {
            Ok(text) if !text.is_empty() => return Ok(Some(ClipboardData::Text(text))),
            Ok(_) | Err(arboard::Error::ContentNotAvailable) => {}
            Err(error) => return Err(error.to_string()),
        }
        match clipboard.get_image() {
            Ok(image) if image.width > 0 && image.height > 0 => {
                let data = encode_png(&image.bytes, image.width as u32, image.height as u32)?;
                Ok(Some(ClipboardData::Image {
                    data,
                    width: image.width as u32,
                    height: image.height as u32,
                }))
            }
            Ok(_) | Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn read_file_urls(pasteboard: &NSPasteboard) -> Option<ClipboardData> {
        let file_type = NSString::from_str("public.file-url");
        let mut paths = Vec::new();
        for item in pasteboard.pasteboardItems()? {
            if let Some(value) = item.stringForType(&file_type) {
                if let Some(url) = NSURL::URLWithString_encodingInvalidCharacters(&value, false) {
                    if let Some(path) = url.to_file_path().and_then(|path| path.to_str().map(str::to_owned)) {
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

    fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
            writer.write_image_data(rgba).map_err(|error| error.to_string())?;
        }
        Ok(bytes)
    }

    fn decode_png(data: &[u8]) -> Result<arboard::ImageData<'static>, String> {
        let decoder = png::Decoder::new(std::io::Cursor::new(data));
        let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
        let mut bytes = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut bytes).map_err(|error| error.to_string())?;
        // Captured images are encoded as RGBA8 above; never pass other layouts to arboard.
        if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
            return Err("Unsupported stored image pixel format".into());
        }
        bytes.truncate(info.buffer_size());
        Ok(arboard::ImageData {
            width: info.width as usize,
            height: info.height as usize,
            bytes: std::borrow::Cow::Owned(bytes),
        })
    }

    pub fn write_text(text: &str) -> Result<(), String> {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(text))
            .map_err(|error| error.to_string())
    }

    pub fn write_image_from_png(data: &[u8]) -> Result<(), String> {
        let image = decode_png(data)?;
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_image(image))
            .map_err(|error| error.to_string())
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
        let refs: Vec<&ProtocolObject<dyn NSPasteboardWriting>> =
            items.iter().map(|item| ProtocolObject::from_ref(&**item)).collect();
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
        fn png_round_trip_preserves_rgba_pixels() {
            let pixels = [255, 0, 0, 255, 0, 255, 0, 128];
            let png = encode_png(&pixels, 2, 1).unwrap();
            let image = decode_png(&png).unwrap();
            assert_eq!((image.width, image.height), (2, 1));
            assert_eq!(&*image.bytes, &pixels);
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
