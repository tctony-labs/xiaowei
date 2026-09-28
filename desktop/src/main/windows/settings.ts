import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import { restrictNavigation } from "./navigation";

export function createSettingsWindow(options: {
  moduleDir: string;
  hideLauncher(): void;
  register(window: BrowserWindow): void;
}) {
  let settingsWindow: BrowserWindow | undefined;

  async function openSettings(): Promise<BrowserWindow> {
    // Capture the source display before hiding the launcher clears its focus.
    const source = BrowserWindow.getFocusedWindow();
    const display = source
      ? screen.getDisplayMatching(source.getBounds())
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { workArea } = display;

    options.hideLauncher();
    if (process.platform === "darwin") app.show();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (screen.getDisplayMatching(settingsWindow.getBounds()).id !== display.id) {
        const [width, height] = settingsWindow.getSize();
        settingsWindow.setPosition(
          Math.round(workArea.x + (workArea.width - width) / 2),
          Math.round(workArea.y + (workArea.height - height) / 2),
        );
      }
      settingsWindow.show();
      settingsWindow.focus();
      return settingsWindow;
    }
    const window = new BrowserWindow({
      x: Math.round(workArea.x + (workArea.width - 800) / 2),
      y: Math.round(workArea.y + (workArea.height - 600) / 2),
      width: 800,
      height: 600,
      minWidth: 700,
      minHeight: 500,
      show: false,
      title: "设置 - XiaoWei",
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
      backgroundColor: "#f7f8fa",
      webPreferences: {
        preload: join(options.moduleDir, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    settingsWindow = window;
    options.register(window);
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      if (settingsWindow === window) settingsWindow = undefined;
    });
    restrictNavigation(window.webContents, !app.isPackaged);
    const query = { window: "settings", version: app.getVersion(), development: String(!app.isPackaged) };
    try {
      if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
        const url = new URL(process.env.ELECTRON_RENDERER_URL);
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
        await window.loadURL(url.href);
      } else {
        await window.loadFile(join(options.moduleDir, "../renderer/index.html"), { query });
      }
      return window;
    } catch (error) {
      window.destroy();
      throw error;
    }
  }

  return { open: openSettings };
}
