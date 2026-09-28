import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import type { LauncherMode } from "../../shared/launcher-model";
import type { createFocusSession } from "./focus-session";
import {
  activateLauncherShortcut,
  configureLauncherWorkspaces,
  positionLauncher,
  showLauncherWindow,
} from "./launcher-shortcuts";
import { restrictNavigation } from "./navigation";

export function createLauncherWindow(options: {
  moduleDir: string;
  register(window: BrowserWindow): void;
  opened(window: BrowserWindow, mode: LauncherMode): void;
  focus?: ReturnType<typeof createFocusSession>;
}) {
  let launcher: BrowserWindow | undefined;
  let launcherMode: LauncherMode = "search";
  let quitting = false;
  let restoring = false;
  let pendingShow: Promise<void> | undefined;
  let ready = false;
  let requestedShow = false;
  let requestedMode: LauncherMode | "toggle" | undefined;
  let generation = 0;

  async function dismiss(restore: boolean): Promise<boolean> {
    if (!launcher || launcher.isDestroyed()) return false;
    generation++;
    restoring = true;
    launcher.hide();
    try {
      if (restore) return (await options.focus?.restore()) ?? true;
      options.focus?.abandon();
      return true;
    } finally {
      restoring = false;
    }
  }

  function openLauncherMode(mode: LauncherMode | "toggle"): void {
    if (!ready) {
      requestedMode = mode;
      return;
    }
    launcherMode = activateLauncherShortcut(
      launcher,
      launcherMode,
      mode,
      showLauncher,
      (window, openedMode) => options.opened(window, openedMode),
      () => {
        void dismiss(true).catch((error) => console.error("Focus restore failed", error));
      },
    );
  }

  function showLauncher(): void {
    if (!ready) {
      requestedShow = true;
      return;
    }
    if (quitting || pendingShow || !launcher || launcher.isDestroyed()) return;
    if (launcher.isVisible()) {
      if (!launcher.isFocused()) launcher.focus();
      return;
    }
    generation++;
    pendingShow = (async () => {
      if (options.focus && !(await options.focus.begin())) return;
      if (!quitting) showLauncherWindow(launcher, screen);
    })()
      .catch((error: unknown) => console.error("Launcher focus capture failed", error))
      .finally(() => {
        pendingShow = undefined;
      });
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
      ready = true;
      resetLauncherPosition();
      if (requestedMode !== undefined) openLauncherMode(requestedMode);
      else if (requestedShow || process.platform !== "darwin") showLauncher();
      requestedMode = undefined;
      requestedShow = false;
    });
    window.on("blur", () => {
      if (!restoring && !window.webContents.isDevToolsOpened()) void dismiss(false);
    });
    window.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        void dismiss(true).catch((error) => console.error("Focus restore failed", error));
      }
    });
    restrictNavigation(window.webContents, !app.isPackaged);
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
      void dismiss(false);
    },
    owns: (window: object) => window === launcher,
    generation: () => generation,
    dismiss,
    modeChanged(mode: LauncherMode) {
      launcherMode = mode;
    },
    prepareQuit() {
      quitting = true;
      options.focus?.abandon();
    },
  };
}
