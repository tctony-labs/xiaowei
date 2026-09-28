import { mkdirSync } from "node:fs";
import { open, utimes } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { app, clipboard, globalShortcut, protocol, screen, shell } from "electron";
import { initializeLogging as initializeClipboardLogging } from "xiaowei-clipboard";
import { EmptySchema } from "xiaowei-contracts";
import { initializeLogging, initializeSearch } from "xiaowei-search";
import { loadConfig } from "../services/llm/config";
import { createSettingsShortcuts, shortcutConfig } from "../services/shortcuts/shortcuts";
import { createLauncherWindow } from "../windows/launcher";
import { positionLauncher } from "../windows/launcher-shortcuts";
import { createOrdinaryWindows } from "../windows/ordinary-windows";
import { createSettingsWindow } from "../windows/settings";
import { createSystemFocus } from "../windows/system-focus";
import { createApplicationGateway } from "./gateway";
import { attachRendererLogging, createLoggers, createNativeLogSink } from "./logging";
import { installMenu } from "./menu";
import { createPaths } from "./paths";
import { createTray } from "./tray";

export function startApplication(moduleDir: string): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "xiaowei-icon", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);

  let gateway: Awaited<ReturnType<typeof createApplicationGateway>> | undefined;
  let tray: ReturnType<typeof createTray> | undefined;
  const ordinaryWindows = createOrdinaryWindows(process.platform === "darwin" ? app.dock : undefined);
  const launcher = createLauncherWindow({
    moduleDir,
    focus: process.platform === "darwin" ? createSystemFocus() : undefined,
    register: (window) => gateway?.register(window),
    opened: (window, mode) => gateway?.opened(window, mode),
  });
  const settingsWindow = createSettingsWindow({
    moduleDir,
    hideLauncher: launcher.hide,
    register(window) {
      ordinaryWindows.register(window);
      gateway?.register(window);
    },
  });
  const shortcuts = createSettingsShortcuts(globalShortcut, process.platform, {
    main: () => launcher.openMode("toggle"),
    quickChat: () => launcher.openMode("quick-chat"),
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
    app.on("second-instance", process.platform === "darwin" ? ordinaryWindows.activate : launcher.show);
    app
      .whenReady()
      .then(async () => {
        ordinaryWindows.initialize();
        installMenu(async () => {
          await settingsWindow.open();
        });
        const models = await loadConfig(process.env, paths.models);
        gateway = await createApplicationGateway(
          paths.clipboard,
          paths.database,
          paths.appIcons,
          {
            development: !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL),
            platform: process.platform,
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
            openSettings: settingsWindow.open,
            windowGeneration: launcher.generation,
            async dismiss(window, restore) {
              if (!launcher.owns(window)) throw new Error("Not a launcher window");
              await launcher.dismiss(restore);
            },
            async hideWindow(window) {
              if (!launcher.owns(window)) throw new Error("Window has no focus session");
              if (!(await launcher.dismiss(true))) throw new Error("Unable to restore focus; clipboard remains copied");
            },
            updateShortcuts(config) {
              shortcuts.replace(config);
            },
          },
          models,
        );
        await launcher.create();
        ordinaryWindows.initialize();
        if (process.platform === "darwin") {
          tray = createTray({
            resourceDirectory: app.isPackaged
              ? join(process.resourcesPath, "tray")
              : join(app.getAppPath(), "resources"),
            showLauncher: launcher.show,
            openSettings: settingsWindow.open,
            quit: () => app.quit(),
          });
        }
        const searchWarmup = setTimeout(() => {
          void initializeSearch().catch((error: unknown) => console.error("Search index initialization failed", error));
        }, 1000);
        searchWarmup.unref();
        app.once("before-quit", () => clearTimeout(searchWarmup));
        shortcuts.registerInitial(shortcutConfig((await gateway.settings.get(create(EmptySchema))).shortcuts));
        app.on("activate", ordinaryWindows.activate);
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
    ordinaryWindows.close();
    tray?.close();
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
