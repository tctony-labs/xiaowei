use block2::{Block, RcBlock};
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyClass, NSObject};
use objc2::{
    define_class, extern_class, msg_send, DeclaredClass, MainThreadMarker, MainThreadOnly,
};
use objc2_foundation::{NSBundle, NSError, NSString};
use std::cell::{Cell, OnceCell, RefCell};
use std::rc::Rc;

extern_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "SPUStandardUpdaterController"]
    struct Controller;
);

#[derive(Clone, Copy, PartialEq)]
enum ManualCheck {
    Idle,
    Waiting,
    Active,
}

struct DelegateIvars {
    event: Rc<dyn Fn(String)>,
    install: RefCell<Option<RcBlock<dyn Fn()>>>,
    manual_check: Rc<Cell<ManualCheck>>,
    user_driver: OnceCell<Retained<NSObject>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "XWPlatformSparkleDelegate"]
    #[ivars = DelegateIvars]
    struct Delegate;

    impl Delegate {
        #[unsafe(method(standardUserDriverShouldHandleShowingScheduledUpdate:andInImmediateFocus:))]
        fn showing_scheduled_update(&self, _item: &NSObject, _focus: bool) -> bool {
            // Let the pending manual request focus the result instead of scheduling it in back.
            self.ivars().manual_check.get() != ManualCheck::Waiting
        }

        #[unsafe(method(standardUserDriverWillHandleShowingUpdate:forUpdate:state:))]
        fn showing_update(&self, handle: bool, _item: &NSObject, _state: &NSObject) {
            let foreground = self.ivars().manual_check.get() == ManualCheck::Waiting;
            if foreground {
                self.ivars().manual_check.set(ManualCheck::Active);
                let driver = self.ivars().user_driver.get().unwrap();
                unsafe {
                    let _: () = msg_send![driver, showUpdateInFocus];
                }
                (self.ivars().event)("manual-check-result update-available".into());
            }
            if handle || foreground {
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
            self.ivars().manual_check.set(ManualCheck::Idle);
            (self.ivars().event)("ui-hidden".into());
        }

        #[unsafe(method(standardUserDriverWillFinishUpdateSession))]
        fn finished_session(&self) {
            if self.ivars().manual_check.get() == ManualCheck::Waiting {
                return;
            }
            self.ivars().manual_check.set(ManualCheck::Idle);
            (self.ivars().event)("ui-hidden".into());
        }

        #[unsafe(method(updater:didFinishUpdateCycleForUpdateCheck:error:))]
        fn finished_check(&self, updater: &NSObject, _check: isize, error: Option<&NSError>) {
            if self.ivars().manual_check.get() == ManualCheck::Waiting {
                let driver = self.ivars().user_driver.get().unwrap();
                if let Some(error) = error {
                    self.ivars().manual_check.set(ManualCheck::Active);
                    let acknowledgement = RcBlock::new(|| {});
                    unsafe {
                        if error.domain().to_string() == "SUSparkleErrorDomain" && error.code() == 1001 {
                            let _: () = msg_send![
                                driver,
                                showUpdateNotFoundWithError: error,
                                acknowledgement: &*acknowledgement,
                            ];
                        } else {
                            let _: () = msg_send![
                                driver,
                                showUpdaterError: error,
                                acknowledgement: &*acknowledgement,
                            ];
                        }
                    }
                } else {
                    // A completed automatic download can be resumed by the interactive driver.
                    // Keep the host visible while replacing our waiting UI with that driver.
                    unsafe {
                        let _: () = msg_send![driver, dismissUpdateInstallation];
                        self.ivars().manual_check.set(ManualCheck::Active);
                        let _: () = msg_send![updater, checkForUpdates];
                    }
                }
                return;
            }
            self.ivars().manual_check.set(ManualCheck::Idle);
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
                event: Rc::new(event),
                install: RefCell::new(None),
                manual_check: Rc::new(Cell::new(ManualCheck::Idle)),
                user_driver: OnceCell::new(),
            });
            let delegate: Retained<Delegate> = msg_send![super(delegate), init];
            let controller: Retained<Controller> = msg_send![
                Controller::alloc(marker),
                initWithStartingUpdater: false,
                updaterDelegate: &*delegate,
                userDriverDelegate: &*delegate,
            ];
            let updater: Retained<NSObject> = msg_send![&controller, updater];
            let driver: Retained<NSObject> = msg_send![&controller, userDriver];
            delegate.ivars().user_driver.set(driver).unwrap();
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
            let state = &self.delegate.ivars().manual_check;
            let driver = self.delegate.ivars().user_driver.get().unwrap();
            if background {
                if !available {
                    return Err("Sparkle update session already in progress".into());
                }
                let _: () = msg_send![&updater, checkForUpdatesInBackground];
            } else if state.get() != ManualCheck::Idle {
                let _: () = msg_send![driver, showUpdateInFocus];
                (self.delegate.ivars().event)("manual-check-focused".into());
            } else if !available {
                state.set(ManualCheck::Waiting);
                let state = state.clone();
                let event = self.delegate.ivars().event.clone();
                let cancellation = RcBlock::new(move || {
                    // Cancel this foreground wait; the original background check continues.
                    state.set(ManualCheck::Idle);
                    event("manual-check-cancelled".into());
                    event("ui-hidden".into());
                });
                let _: () = msg_send![
                    driver,
                    showUserInitiatedUpdateCheckWithCancellation: &*cancellation,
                ];
                (self.delegate.ivars().event)("manual-check-waiting".into());
            } else {
                state.set(ManualCheck::Active);
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

impl Drop for SparkleUpdater {
    fn drop(&mut self) {
        if self.delegate.ivars().manual_check.get() == ManualCheck::Waiting {
            let driver = self.delegate.ivars().user_driver.get().unwrap();
            self.delegate.ivars().manual_check.set(ManualCheck::Idle);
            unsafe {
                let _: () = msg_send![driver, dismissUpdateInstallation];
            }
        }
    }
}
