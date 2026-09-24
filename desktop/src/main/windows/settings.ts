import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { restrictNavigation } from "./navigation";

export function createSettingsWindow(options: {
  moduleDir: string;
  hideLauncher(): void;
  register(window: BrowserWindow): void;
}) {
  let settingsWindow: BrowserWindow | undefined;

  async function openSettings(): Promise<void> {
    options.hideLauncher();
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
    } catch (error) {
      window.destroy();
      throw error;
    }
  }

  return { open: openSettings };
}
