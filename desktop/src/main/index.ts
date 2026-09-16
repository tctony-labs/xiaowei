import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(moduleDir, "../../..");

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
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      await createWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow();
      });
    })
    .catch((error: unknown) => {
      console.error("Application startup failed", error);
      app.quit();
    });
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 600,
    minHeight: 480,
    title: "XiaoWei",
    backgroundColor: "#fafaf9",
    webPreferences: {
      preload: join(moduleDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
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
