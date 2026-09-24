import { mkdirSync } from "node:fs";
import { open, utimes } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { app, clipboard, globalShortcut, protocol, screen, shell } from "electron";
import { initializeLogging as initializeClipboardLogging } from "xiaowei-clipboard";
import { EmptySchema } from "xiaowei-contracts";
import { initializeLogging, initializeSearch } from "xiaowei-search";
import { createLauncherWindow } from "../windows/launcher";
import { positionLauncher } from "../windows/launcher-shortcuts";
import { createSettingsWindow } from "../windows/settings";
import { createApplicationGateway } from "./gateway";
import { attachRendererLogging, createLoggers, createNativeLogSink } from "./logging";
import { installMenu } from "./menu";
import { createPaths } from "./paths";
import { createSettingsShortcuts, shortcutConfig } from "./shortcuts";

export function startApplication(moduleDir: string): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "xiaowei-icon", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);

  let gateway: Awaited<ReturnType<typeof createApplicationGateway>> | undefined;
  const launcher = createLauncherWindow({
    moduleDir,
    register: (window) => gateway?.register(window),
    opened: (window, mode) => gateway?.opened(window, mode),
  });
  const settingsWindow = createSettingsWindow({
    moduleDir,
    hideLauncher: launcher.hide,
    register: (window) => gateway?.register(window),
  });
  const shortcuts = createSettingsShortcuts(globalShortcut, process.platform, {
    main: () => launcher.openMode("search"),
    clipboard: () => launcher.openMode("clipboard"),
  });

  app.setName("XiaoWei");
  app.setAppUserModelId("com.tctony.xiaowei");
  const paths = createPaths(app.getPath("appData"));
  mkdirSync(paths.userData, { recursive: true });
  app.setPath("userData", paths.userData);

  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    const logs = createLoggers(paths.logs, !app.isPackaged);
    Object.assign(console, logs.main.functions);
    process.on("uncaughtExceptionMonitor", (error, origin) => logs.main.error(origin, error));
    process.on("unhandledRejection", (error) => logs.main.error("Unhandled rejection", error));
    const nativeLog = createNativeLogSink(logs.main);
    initializeLogging(!app.isPackaged, nativeLog);
    initializeClipboardLogging(!app.isPackaged, nativeLog);
    app.on("web-contents-created", (_event, contents) => {
      if (contents.getType() === "window") attachRendererLogging(contents, logs.renderer);
    });
    console.info("Application starting", {
      version: app.getVersion(),
      logs: paths.logs,
    });
    app.on("will-quit", () => console.info("Application stopping"));
    app.on("second-instance", launcher.show);
    app
      .whenReady()
      .then(async () => {
        installMenu(settingsWindow.open);
        gateway = await createApplicationGateway(paths.clipboard, paths.database, paths.appIcons, {
          development: !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL),
          platform: process.platform,
          openPath: (path) => shell.openPath(path),
          openExternal: (url) => shell.openExternal(url),
          writeText: (text) => clipboard.writeText(text),
          async restart() {
            const path = join(app.getAppPath(), ".rs");
            const file = await open(path, "a");
            await file.close();
            const now = new Date();
            await utimes(path, now, now);
          },
          resetPosition(window) {
            const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
            positionLauncher(window, workArea);
          },
          modeChanged(mode) {
            launcher.modeChanged(mode);
          },
          updateShortcuts(config) {
            shortcuts.replace(config);
          },
        });
        await launcher.create();
        const searchWarmup = setTimeout(() => {
          void initializeSearch().catch((error: unknown) => console.error("Search index initialization failed", error));
        }, 1000);
        searchWarmup.unref();
        app.once("before-quit", () => clearTimeout(searchWarmup));
        shortcuts.registerInitial(shortcutConfig((await gateway.settings.get(create(EmptySchema))).shortcuts));
        app.on("activate", launcher.show);
      })
      .catch((error: unknown) => {
        console.error("Application startup failed", error);
        app.quit();
      });
  }

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  let shutdownComplete = false;
  app.on("before-quit", (event) => {
    launcher.prepareQuit();
    if (gateway && !shutdownComplete) {
      event.preventDefault();
      void gateway.close().finally(() => {
        shutdownComplete = true;
        app.quit();
      });
    }
  });
  app.on("will-quit", () => {
    shortcuts.close();
    globalShortcut.unregisterAll();
  });
}
