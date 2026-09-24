use napi_derive::napi;

#[napi]
pub fn request_accessibility_permission() -> bool {
    xiaowei_clipboard::request_accessibility_permission()
}

#[napi]
pub fn send_paste_shortcut() -> napi::Result<bool> {
    xiaowei_clipboard::send_paste_shortcut().map_err(|error| napi::Error::from_reason(error.to_string()))
}
