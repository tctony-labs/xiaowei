import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import type { LauncherMode } from "../../shared/launcher-model";
import {
  activateLauncherShortcut,
  configureLauncherWorkspaces,
  positionLauncher,
  showLauncherWindow,
} from "./launcher-shortcuts";

export function createLauncherWindow(options: {
  moduleDir: string;
  register(window: BrowserWindow): void;
  opened(window: BrowserWindow, mode: LauncherMode): void;
}) {
  let launcher: BrowserWindow | undefined;
  let launcherMode: LauncherMode = "search";
  let quitting = false;

  function openLauncherMode(mode: LauncherMode): void {
    launcherMode = activateLauncherShortcut(launcher, launcherMode, mode, showLauncher, (window, openedMode) =>
      options.opened(window, openedMode),
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
        preload: join(options.moduleDir, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    configureLauncherWorkspaces(window);
    launcher = window;
    options.register(window);
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
        await window.loadFile(join(options.moduleDir, "../renderer/index.html"));
      }
    } catch (error) {
      // Reloading or closing the window can cancel an in-progress navigation.
      if (error instanceof Error && "code" in error && error.code === "ERR_ABORTED") return;
      throw error;
    }
  }

  return {
    create: createWindow,
    show: showLauncher,
    openMode: openLauncherMode,
    hide() {
      launcher?.hide();
    },
    modeChanged(mode: LauncherMode) {
      launcherMode = mode;
    },
    prepareQuit() {
      quitting = true;
    },
  };
}
