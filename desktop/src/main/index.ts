import { mkdirSync } from "node:fs";
import { open, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { app, BrowserWindow, clipboard, globalShortcut, Menu, protocol, screen, shell } from "electron";
import { initializeLogging as initializeClipboardLogging } from "xiaowei-clipboard";
import { EmptySchema } from "xiaowei-contracts";
import { initializeLogging, initializeSearch } from "xiaowei-search";
import type { LauncherMode } from "../shared/launcher-model";
import { createApplicationGateway } from "./gateway";
import {
  activateLauncherShortcut,
  configureLauncherWorkspaces,
  positionLauncher,
  showLauncherWindow,
} from "./launcher-shortcuts";
import { attachRendererLogging, createLoggers } from "./logging";
import { createPaths } from "./paths";
import { createSettingsShortcuts, shortcutConfig } from "./settings-shortcuts";

protocol.registerSchemesAsPrivileged([
  { scheme: "xiaowei-icon", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const moduleDir = dirname(fileURLToPath(import.meta.url));
let gateway: Awaited<ReturnType<typeof createApplicationGateway>> | undefined;
let launcher: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let quitting = false;
let launcherMode: LauncherMode = "search";
const shortcuts = createSettingsShortcuts(globalShortcut, process.platform, {
  main: () => openLauncherMode("search"),
  clipboard: () => openLauncherMode("clipboard"),
});

function openLauncherMode(mode: LauncherMode): void {
  launcherMode = activateLauncherShortcut(launcher, launcherMode, mode, showLauncher, (window, openedMode) =>
    gateway?.opened(window, openedMode),
  );
}

function showLauncher(): void {
  showLauncherWindow(launcher, screen);
}

function resetLauncherPosition(): void {
  if (!launcher || launcher.isDestroyed()) return;
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  positionLauncher(launcher, workArea);
}

async function openSettings(): Promise<void> {
  launcher?.hide();
  if (process.platform === "darwin") app.show();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 700,
    minHeight: 500,
    show: false,
    title: "设置 - XiaoWei",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#f7f8fa",
    webPreferences: {
      preload: join(moduleDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow = window;
  gateway?.register(window);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (settingsWindow === window) settingsWindow = undefined;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const query = { window: "settings", version: app.getVersion(), development: String(!app.isPackaged) };
  try {
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      const url = new URL(process.env.ELECTRON_RENDERER_URL);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      await window.loadURL(url.href);
    } else {
      await window.loadFile(join(moduleDir, "../renderer/index.html"), { query });
    }
  } catch (error) {
    window.destroy();
    throw error;
  }
}

function installMenu(): void {
  const settingsItem = {
    label: "设置…",
    accelerator: "CommandOrControl+,",
    click: () => void openSettings().catch((error: unknown) => console.error("Open settings failed", error)),
  };
  const menu = Menu.buildFromTemplate([
    ...(process.platform === "darwin"
      ? [
          { label: app.name, submenu: [settingsItem, { type: "separator" as const }, { role: "quit" as const }] },
          { label: "文件", submenu: [{ role: "close" as const }] },
        ]
      : [
          {
            label: "文件",
            submenu: [
              settingsItem,
              { type: "separator" as const },
              { role: "close" as const },
              { role: "quit" as const },
            ],
          },
        ]),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);
}

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
  const nativeLog = ({
    level,
    message,
    file,
    line,
  }: {
    level: string;
    message: string;
    file?: string | null;
    line?: number | null;
  }) => {
    const method = level === "trace" ? "debug" : level;
    if (method === "error" || method === "warn" || method === "info" || method === "debug") {
      const location = file ? `[${file}${line == null ? "" : `:${line}`}] ` : "";
      logs.main[method](`${location}${message}`);
    }
  };
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
  app.on("second-instance", showLauncher);
  app
    .whenReady()
    .then(async () => {
      installMenu();
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
          launcherMode = mode;
        },
        updateShortcuts(config) {
          shortcuts.replace(config);
        },
      });
      await createWindow();
      const searchWarmup = setTimeout(() => {
        void initializeSearch().catch((error: unknown) => console.error("Search index initialization failed", error));
      }, 1000);
      searchWarmup.unref();
      app.once("before-quit", () => clearTimeout(searchWarmup));
      shortcuts.registerInitial(shortcutConfig((await gateway.settings.get(create(EmptySchema))).shortcuts));
      app.on("activate", showLauncher);
    })
    .catch((error: unknown) => {
      console.error("Application startup failed", error);
      app.quit();
    });
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 800,
    height: 71,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    transparent: true,
    hasShadow: false,
    title: "XiaoWei",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(moduleDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  configureLauncherWorkspaces(window);
  launcher = window;
  gateway?.register(window);
  window.once("ready-to-show", () => {
    resetLauncherPosition();
    showLauncher();
  });
  window.on("blur", () => {
    if (!window.webContents.isDevToolsOpened()) window.hide();
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  try {
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      await window.loadFile(join(moduleDir, "../renderer/index.html"));
    }
  } catch (error) {
    // Reloading or closing the window can cancel an in-progress navigation.
    if (error instanceof Error && "code" in error && error.code === "ERR_ABORTED") return;
    throw error;
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let shutdownComplete = false;
app.on("before-quit", (event) => {
  quitting = true;
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
