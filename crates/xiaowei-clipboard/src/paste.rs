#[cfg(target_os = "macos")]
use core_foundation::{base::TCFType, boolean::CFBoolean, dictionary::CFDictionary, string::CFString};
#[cfg(target_os = "macos")]
use core_graphics::{
    event::{CGEvent, CGEventFlags, CGEventTapLocation},
    event_source::{CGEventSource, CGEventSourceStateID},
};

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> u8;
}

pub fn request_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        if unsafe { AXIsProcessTrusted() } != 0 {
            return true;
        }
        let options =
            CFDictionary::from_CFType_pairs(&[(CFString::new("AXTrustedCheckOptionPrompt"), CFBoolean::true_value())]);
        unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef().cast()) != 0 }
    }
    #[cfg(not(target_os = "macos"))]
    false
}

// False means macOS has been asked for Accessibility permission; the clipboard stays copied.
pub fn send_paste_shortcut() -> crate::Result<bool> {
    #[cfg(target_os = "macos")]
    {
        if !request_accessibility_permission() {
            return Ok(false);
        }

        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "Unable to create paste event source")?;
        let down =
            CGEvent::new_keyboard_event(source.clone(), 0x09, true).map_err(|_| "Unable to create paste key down")?;
        let up = CGEvent::new_keyboard_event(source, 0x09, false).map_err(|_| "Unable to create paste key up")?;
        down.set_flags(CGEventFlags::CGEventFlagCommand);
        up.set_flags(CGEventFlags::CGEventFlagCommand);
        down.post(CGEventTapLocation::HID);
        up.post(CGEventTapLocation::HID);
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    Err("Automatic paste requires macOS".into())
}
