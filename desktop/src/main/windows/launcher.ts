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
import type { createOrdinaryWindows } from "./ordinary-windows";

export function createLauncherWindow(options: {
  moduleDir: string;
  register(window: BrowserWindow): void;
  opened(window: BrowserWindow, mode: LauncherMode): void;
  focus?: ReturnType<typeof createFocusSession>;
  ordinaryWindows?: Pick<
    ReturnType<typeof createOrdinaryWindows>,
    "register" | "unregister" | "setTransientWindowVisible"
  >;
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

  function updateOrdinaryWindow(): void {
    if (!launcher || launcher.isDestroyed()) return;
    const visible = launcher.isVisible();
    const ordinary = visible && launcherMode === "quick-chat";
    if (ordinary) {
      options.ordinaryWindows?.register(launcher);
      options.ordinaryWindows?.setTransientWindowVisible(false);
    } else {
      options.ordinaryWindows?.setTransientWindowVisible(visible);
      options.ordinaryWindows?.unregister(launcher);
    }
    console.debug("Launcher window state changed", { mode: launcherMode, visible, ordinary });
  }

  function modeChanged(mode: LauncherMode): void {
    if (launcherMode === mode) return;
    launcherMode = mode;
    if (launcher && !launcher.isDestroyed()) {
      launcher.setAlwaysOnTop(mode !== "quick-chat");
    }
    updateOrdinaryWindow();
  }

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
    activateLauncherShortcut(
      launcher,
      launcherMode,
      mode,
      showLauncher,
      (window, openedMode) => {
        modeChanged(openedMode);
        options.opened(window, openedMode);
      },
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
      alwaysOnTop: launcherMode !== "quick-chat",
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
    window.on("show", updateOrdinaryWindow);
    window.on("hide", updateOrdinaryWindow);
    window.once("ready-to-show", () => {
      ready = true;
      resetLauncherPosition();
      if (requestedMode !== undefined) openLauncherMode(requestedMode);
      else if (requestedShow || process.platform !== "darwin") showLauncher();
      requestedMode = undefined;
      requestedShow = false;
    });
    window.on("blur", () => {
      if (restoring || window.webContents.isDevToolsOpened()) return;

      // macOS main-window changes can emit blur while a floating window stays key.
      const focused = window.isFocused();
      const retained = focused || launcherMode === "quick-chat";

      console.debug("Launcher window blurred", {
        mode: launcherMode,
        focused,
        retained,
      });

      if (!retained) void dismiss(false);
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
    modeChanged,
    prepareQuit() {
      quitting = true;
      options.focus?.abandon();
    },
  };
}
