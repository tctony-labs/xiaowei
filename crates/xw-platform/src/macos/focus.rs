use core_foundation::{base::TCFType, string::CFString};
use objc2::rc::{autoreleasepool, Retained};
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
use std::ffi::c_void;
use std::ptr;

type AxElement = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> AxElement;
    fn AXUIElementSetMessagingTimeout(element: AxElement, timeout: f32) -> i32;
    fn AXUIElementCopyAttributeValue(element: AxElement, name: *const c_void, value: *mut AxElement) -> i32;
    fn AXUIElementPerformAction(element: AxElement, action: *const c_void) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: *const c_void);
    fn CFEqual(left: *const c_void, right: *const c_void) -> bool;
}

struct OwnedElement(AxElement);

// AX objects are remote references without thread affinity. Access to a snapshot
// is serialized by its owner; moving an owned reference does not duplicate it.
unsafe impl Send for OwnedElement {}

impl Drop for OwnedElement {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}

fn focused_window(pid: i32) -> Option<OwnedElement> {
    if !unsafe { AXIsProcessTrusted() } {
        return None;
    }
    let application = unsafe { AXUIElementCreateApplication(pid) };
    if application.is_null() {
        return None;
    }
    let application = OwnedElement(application);
    unsafe { AXUIElementSetMessagingTimeout(application.0, 0.1) };
    let attribute = CFString::new("AXFocusedWindow");
    let mut window = ptr::null();
    let result =
        unsafe { AXUIElementCopyAttributeValue(application.0, attribute.as_concrete_TypeRef().cast(), &mut window) };
    if result != 0 || window.is_null() {
        return None;
    }
    unsafe { AXUIElementSetMessagingTimeout(window, 0.1) };
    Some(OwnedElement(window))
}

pub fn frontmost_process() -> Option<u32> {
    autoreleasepool(|_| {
        NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|application| application.processIdentifier() as u32)
    })
}

pub struct FocusSnapshot {
    application: Retained<NSRunningApplication>,
    window: Option<OwnedElement>,
}

impl FocusSnapshot {
    pub fn capture() -> Option<Self> {
        autoreleasepool(|_| {
            let application = NSWorkspace::sharedWorkspace().frontmostApplication()?;
            let window = focused_window(application.processIdentifier());
            Some(Self { application, window })
        })
    }

    pub fn process_id(&self) -> u32 {
        self.application.processIdentifier() as u32
    }

    pub fn restore(&mut self, expected_process: u32) -> bool {
        autoreleasepool(|_| {
            if self.application.isTerminated() {
                return false;
            }
            let foreground = frontmost_process();
            if foreground != Some(expected_process) && foreground != Some(self.process_id()) {
                return false;
            }
            if !self
                .application
                .activateWithOptions(NSApplicationActivationOptions::empty())
            {
                return false;
            }
            if let Some(window) = &self.window {
                let action = CFString::new("AXRaise");
                // An invalid or inaccessible window falls back to application activation.
                let result = unsafe { AXUIElementPerformAction(window.0, action.as_concrete_TypeRef().cast()) };
                if result != 0 {
                    self.window = None;
                }
            }
            true
        })
    }

    pub fn is_frontmost(&self) -> bool {
        autoreleasepool(|_| {
            if self.application.isTerminated() || frontmost_process() != Some(self.process_id()) {
                return false;
            }
            match (&self.window, focused_window(self.application.processIdentifier())) {
                (Some(expected), Some(actual)) => unsafe { CFEqual(expected.0, actual.0) },
                _ => true,
            }
        })
    }
}
