import type { SparkleUpdater } from "xiaowei-rust";

type Updater = Pick<SparkleUpdater, "check" | "resumeInstall" | "close">;

export function createUpdateService(options: {
  packaged: boolean;
  platform: string;
  frameworkPath: string;
  open(path: string, event: (event: string) => void): Updater;
  windowVisibilityChanged(visible: boolean): void;
  prepareInstall(): Promise<void>;
}) {
  let updater: Updater | undefined;
  let closed = false;
  let preparing = false;
  let windowVisible = false;

  function setWindowVisible(visible: boolean) {
    if (windowVisible === visible) return;
    windowVisible = visible;
    options.windowVisibilityChanged(visible);
    console.info("Sparkle window visibility changed", visible);
  }

  function event(message: string) {
    if (closed) return;
    if (message.startsWith("error ")) {
      console.warn("Sparkle update failed", message.slice(6));
      return;
    }
    if (message === "ui-visible" || message === "ui-hidden") {
      setWindowVisible(message === "ui-visible");
      return;
    }
    console.info("Sparkle update event", message);
    if (message !== "prepare-install" || preparing) return;
    preparing = true;
    void options
      .prepareInstall()
      .then(() => {
        if (!closed) updater?.resumeInstall();
      })
      .catch((error: unknown) => console.error("Sparkle installation preparation failed", error));
  }

  return {
    start() {
      if (closed || updater || !options.packaged || options.platform !== "darwin") return;
      try {
        updater = options.open(options.frameworkPath, event);
        console.info("Sparkle updater ready");
        updater.check(true);
        console.info("Sparkle background check started");
      } catch (error) {
        console.warn("Sparkle startup failed", error);
      }
    },
    check() {
      if (closed || !updater) throw new Error("Sparkle updater unavailable in this application");
      const wasVisible = windowVisible;
      setWindowVisible(true);
      try {
        updater.check(false);
      } catch (error) {
        setWindowVisible(wasVisible);
        throw error;
      }
      console.info("Sparkle interactive check started");
    },
    close() {
      if (closed) return;
      setWindowVisible(false);
      closed = true;
      updater?.close();
      updater = undefined;
    },
  };
}
