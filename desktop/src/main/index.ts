import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(moduleDir, "../../..");
let launcher: BrowserWindow | undefined;
let quitting = false;

function showLauncher(): void {
  if (!launcher || launcher.isDestroyed()) return;
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [width, height] = launcher.getSize();
  launcher.setPosition(
    Math.round(workArea.x + (workArea.width - width) / 2),
    Math.round(workArea.y + Math.max(0, (workArea.height - height) / 3)),
  );
  launcher.show();
  launcher.focus();
}

app.setName("XiaoWei");
app.setAppUserModelId("com.tctony.xiaowei");
if (!app.isPackaged) {
  const workspaceId = createHash("sha256").update(workspace).digest("hex").slice(0, 12);
  const userData = join(app.getPath("appData"), "com.tctony.xiaowei.dev", workspaceId);
  mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showLauncher);
  app
    .whenReady()
    .then(async () => {
      ipcMain.on("launcher:hide", (event) => {
        if (event.sender === launcher?.webContents && event.senderFrame === event.sender.mainFrame) {
          launcher.hide();
        }
      });
      await createWindow();
      const shortcut = process.platform === "darwin" ? "Command+Alt+Space" : "Control+Alt+Space";
      if (
        !globalShortcut.register(shortcut, () => {
          if (launcher?.isVisible() && launcher.isFocused()) launcher.hide();
          else showLauncher();
        })
      ) {
        console.error(`Launcher shortcut unavailable: ${shortcut}`);
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
  window.once("ready-to-show", showLauncher);
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
