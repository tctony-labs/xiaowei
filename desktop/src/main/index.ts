import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import { initializeLogging as initializeClipboardLogging } from "xiaowei-clipboard";
import { initializeLogging, initializeSearch } from "xiaowei-search";
import type { LauncherMode } from "../shared/launcher-api";
import { registerClipboard } from "./clipboard";
import { activateLauncherShortcut, positionLauncher, showLauncherWindow } from "./launcher-shortcuts";
import { attachRendererLogging, createLoggers } from "./logging";
import { createPaths } from "./paths";
import { registerSearch } from "./search";

const moduleDir = dirname(fileURLToPath(import.meta.url));
let launcher: BrowserWindow | undefined;
let quitting = false;
let launcherMode: LauncherMode = "search";

function showLauncher(): void {
  showLauncherWindow(launcher);
}

function resetLauncherPosition(): void {
  if (!launcher || launcher.isDestroyed()) return;
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  positionLauncher(launcher, workArea);
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
  const nativeLog = ({ level, target, message }: { level: string; target: string; message: string }) => {
    const method = level === "trace" ? "debug" : level;
    if (method === "error" || method === "warn" || method === "info" || method === "debug") {
      logs.main[method](`[rust:${target}] ${message}`);
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
      ipcMain.on("launcher:hide", (event) => {
        if (event.sender === launcher?.webContents && event.senderFrame === event.sender.mainFrame) {
          launcher.hide();
        }
      });
      ipcMain.on("launcher:resetPosition", (event) => {
        if (event.sender === launcher?.webContents && event.senderFrame === event.sender.mainFrame) {
          resetLauncherPosition();
          showLauncher();
        }
      });
      registerSearch(
        () => launcher,
        (mode) => {
          launcherMode = mode;
        },
      );
      registerClipboard(paths.clipboard, () => launcher);
      await createWindow();
      const searchWarmup = setTimeout(() => {
        void initializeSearch().catch((error: unknown) => console.error("Search index initialization failed", error));
      }, 1000);
      searchWarmup.unref();
      app.once("before-quit", () => clearTimeout(searchWarmup));
      const shortcuts: [string, LauncherMode][] = [
        [process.platform === "darwin" ? "Command+Space" : "Control+Alt+Space", "search"],
        ["CommandOrControl+Shift+X", "clipboard"],
      ];
      for (const [shortcut, mode] of shortcuts) {
        if (
          !globalShortcut.register(shortcut, () => {
            launcherMode = activateLauncherShortcut(launcher, launcherMode, mode, showLauncher);
          })
        ) {
          console.error(`Launcher shortcut unavailable: ${shortcut} (${mode})`);
        }
      }
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
    title: "XiaoWei",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(moduleDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  launcher = window;
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

app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", () => globalShortcut.unregisterAll());
