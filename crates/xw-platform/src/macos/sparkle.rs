use block2::{Block, RcBlock};
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyClass, NSObject};
use objc2::{define_class, extern_class, msg_send, DeclaredClass, MainThreadMarker, MainThreadOnly};
use objc2_foundation::{NSBundle, NSError, NSString};
use std::cell::RefCell;

extern_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "SPUStandardUpdaterController"]
    struct Controller;
);

struct DelegateIvars {
    event: Box<dyn Fn(String)>,
    install: RefCell<Option<RcBlock<dyn Fn()>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "XWPlatformSparkleDelegate"]
    #[ivars = DelegateIvars]
    struct Delegate;

    impl Delegate {
        #[unsafe(method(standardUserDriverWillHandleShowingUpdate:forUpdate:state:))]
        fn showing_update(&self, handle: bool, _item: &NSObject, _state: &NSObject) {
            if handle {
                (self.ivars().event)("ui-visible".into());
            }
        }

        #[unsafe(method(standardUserDriverWillShowModalAlert))]
        fn showing_alert(&self) {
            (self.ivars().event)("ui-visible".into());
        }

        #[unsafe(method(standardUserDriverDidShowModalAlert))]
        fn finished_alert(&self) {
            // Sparkle invokes this after the modal alert has been dismissed.
            (self.ivars().event)("ui-hidden".into());
        }

        #[unsafe(method(standardUserDriverWillFinishUpdateSession))]
        fn finished_session(&self) {
            (self.ivars().event)("ui-hidden".into());
        }

        #[unsafe(method(updater:didFinishUpdateCycleForUpdateCheck:error:))]
        fn finished_check(&self, _updater: &NSObject, _check: isize, _error: Option<&NSError>) {
            (self.ivars().event)("ui-hidden".into());
        }

        #[unsafe(method(updater:didFindValidUpdate:))]
        fn found(&self, _updater: &NSObject, item: &NSObject) {
            let version: Retained<NSString> = unsafe { msg_send![item, displayVersionString] };
            (self.ivars().event)(format!("update-available {version}"));
        }

        #[unsafe(method(updaterDidNotFindUpdate:))]
        fn not_found(&self, _updater: &NSObject) {
            (self.ivars().event)("update-not-available".into());
        }

        #[unsafe(method(updater:didAbortWithError:))]
        fn failed(&self, _updater: &NSObject, error: &NSError) {
            // Sparkle also reports a successful no-update check through this callback.
            if error.domain().to_string() == "SUSparkleErrorDomain" && error.code() == 1001 {
                return;
            }
            (self.ivars().event)(format!("error {}", error.localizedDescription()));
        }

        #[unsafe(method(updater:shouldPostponeRelaunchForUpdate:untilInvokingBlock:))]
        fn postpone(&self, _updater: &NSObject, _item: &NSObject, install: &Block<dyn Fn()>) -> bool {
            *self.ivars().install.borrow_mut() = Some(install.copy());
            (self.ivars().event)("prepare-install".into());
            true
        }
    }
);

pub struct SparkleUpdater {
    // Release the controller before its delegate. Sparkle holds the delegate weakly;
    // SPUUpdater has no setDelegate: method and needs no explicit detachment.
    controller: Retained<Controller>,
    delegate: Retained<Delegate>,
    // Keep the dynamically loaded framework alive as long as its objects.
    _bundle: Retained<NSBundle>,
}

fn main_thread() -> Result<MainThreadMarker, String> {
    MainThreadMarker::new().ok_or_else(|| "Sparkle must be called on the macOS main thread".into())
}

impl SparkleUpdater {
    pub fn open(framework: &str, event: impl Fn(String) + 'static) -> Result<Self, String> {
        let marker = main_thread()?;
        autoreleasepool(|_| unsafe {
            let app = NSBundle::mainBundle();
            for key in ["SUFeedURL", "SUPublicEDKey"] {
                let value: Option<Retained<NSString>> =
                    msg_send![&app, objectForInfoDictionaryKey: &*NSString::from_str(key)];
                if value.as_ref().is_none_or(|value| value.is_empty()) {
                    return Err(format!("Missing {key} in application Info.plist"));
                }
            }

            let bundle = NSBundle::bundleWithPath(&NSString::from_str(framework))
                .ok_or_else(|| "Sparkle.framework not found".to_string())?;
            bundle
                .loadAndReturnError()
                .map_err(|error| error.localizedDescription().to_string())?;
            if AnyClass::get(c"SPUStandardUpdaterController").is_none() {
                return Err("Sparkle updater class not found".into());
            }

            let delegate = Delegate::alloc(marker).set_ivars(DelegateIvars {
                event: Box::new(event),
                install: RefCell::new(None),
            });
            let delegate: Retained<Delegate> = msg_send![super(delegate), init];
            let controller: Retained<Controller> = msg_send![
                Controller::alloc(marker),
                initWithStartingUpdater: false,
                updaterDelegate: &*delegate,
                userDriverDelegate: &*delegate,
            ];
            let updater: Retained<NSObject> = msg_send![&controller, updater];
            let _: Option<Retained<NSObject>> = msg_send![&updater, clearFeedURLFromUserDefaults];
            let mut error: *mut NSError = std::ptr::null_mut();
            let started: bool = msg_send![&updater, startUpdater: &mut error];
            if !started {
                return Err(error.as_ref().map_or_else(
                    || "Sparkle failed to start".into(),
                    |error| error.localizedDescription().to_string(),
                ));
            }

            Ok(Self {
                controller,
                delegate,
                _bundle: bundle,
            })
        })
    }

    pub fn check(&self, background: bool) -> Result<(), String> {
        main_thread()?;
        autoreleasepool(|_| unsafe {
            let updater: Retained<NSObject> = msg_send![&self.controller, updater];
            let available: bool = msg_send![&updater, canCheckForUpdates];
            if !available {
                return Err("Sparkle update session already in progress".into());
            }
            if background {
                let _: () = msg_send![&updater, checkForUpdatesInBackground];
            } else {
                let _: () = msg_send![&self.controller, checkForUpdates: Option::<&NSObject>::None];
            }
            Ok(())
        })
    }

    pub fn resume_install(&self) -> Result<(), String> {
        main_thread()?;
        let install = self
            .delegate
            .ivars()
            .install
            .borrow_mut()
            .take()
            .ok_or_else(|| "No Sparkle installation is waiting".to_string())?;
        autoreleasepool(|_| install.call(()));
        Ok(())
    }
}
