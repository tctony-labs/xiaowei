import type { SparkleUpdater } from "xiaowei-platform";

type Updater = Pick<SparkleUpdater, "check" | "resumeInstall" | "close">;

export function createUpdateService(options: {
  packaged: boolean;
  platform: string;
  frameworkPath: string;
  open(path: string, event: (event: string) => void): Updater;
  prepareInstall(): Promise<void>;
}) {
  let updater: Updater | undefined;
  let closed = false;
  let preparing = false;

  function event(message: string) {
    if (closed) return;
    if (message.startsWith("error ")) {
      console.warn("Sparkle update failed", message.slice(6));
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
      updater.check(false);
      console.info("Sparkle interactive check started");
    },
    close() {
      if (closed) return;
      closed = true;
      updater?.close();
      updater = undefined;
    },
  };
}
