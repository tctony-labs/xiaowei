import { open, utimes } from "node:fs/promises";
import { join } from "node:path";
import { app, type BrowserWindow, clipboard, type IpcMainInvokeEvent, ipcMain, shell } from "electron";
import { readAppIcon, recordUsage, type SearchHit, search, toggleSystemTheme } from "xiaowei-search";
import { type LauncherMode, launcherHeight } from "../shared/launcher-api";

export function registerSearch(
  getWindow: () => BrowserWindow | undefined,
  onModeChange: (mode: LauncherMode) => void,
): void {
  let token = 0;
  let results = new Map<string, SearchHit>();
  const icons = new Map<string, Promise<string | null>>();
  function validate(event: IpcMainInvokeEvent): BrowserWindow {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Invalid search caller");
    }
    return window;
  }
  ipcMain.handle("launcher:search", async (event, query: unknown) => {
    validate(event);
    if (typeof query !== "string" || Buffer.byteLength(query) > 4096) throw new Error("Invalid search query");
    const request = ++token;
    results = new Map();
    const hits = await search(query, !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL));
    if (request !== token) return { token: request, hits: [] };
    results = new Map(hits.map((hit) => [hit.id, hit]));
    return {
      token: request,
      hits: hits.map(({ id, title, provider, label, score, ranges }) => ({
        id,
        title,
        provider,
        label,
        score,
        ranges,
      })),
    };
  });
  ipcMain.handle("launcher:execute", async (event, request: unknown, id: unknown) => {
    const window = validate(event);
    const hit = request === token && typeof id === "string" ? results.get(id) : undefined;
    if (!hit) throw new Error("Search result expired");
    switch (hit.actionType) {
      case "runCommand":
        if (hit.actionValue === "clipboard") {
          recordUsage(hit.recencyKey);
          return "clipboard";
        }
        if (hit.actionValue === "toggle-system-theme" && process.platform === "darwin") {
          await toggleSystemTheme();
        } else if (hit.actionValue === "rs" && !app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
          const path = join(app.getAppPath(), ".rs");
          const file = await open(path, "a");
          await file.close();
          const now = new Date();
          await utimes(path, now, now);
        } else {
          throw new Error("Unsupported command");
        }
        break;
      case "copyText":
        clipboard.writeText(hit.actionValue);
        break;
      case "launchApp": {
        const error = await shell.openPath(hit.actionValue);
        if (error) throw new Error(error);
        break;
      }
      case "openUrl": {
        const url = new URL(hit.actionValue);
        const web = url.protocol === "https:" || url.protocol === "http:";
        const settings = hit.provider === "app" && url.protocol === "x-apple.systempreferences:";
        if (!web && !settings) throw new Error("Unsupported URL scheme");
        await shell.openExternal(url.href);
        break;
      }
      default:
        throw new Error("Unsupported search action");
    }
    if (hit.provider !== "calculator") recordUsage(hit.recencyKey);
    window.hide();
  });
  ipcMain.handle("launcher:icon", async (event, request: unknown, id: unknown) => {
    validate(event);
    const hit = request === token && typeof id === "string" ? results.get(id) : undefined;
    if (hit?.actionType !== "launchApp") return null;
    const path = hit.actionValue;
    let icon = icons.get(path);
    if (!icon) {
      icon = readAppIcon(path)
        .then((png) => {
          if (!png) {
            icons.delete(path);
            return null;
          }
          return `data:image/png;base64,${png.toString("base64")}`;
        })
        .catch((error: unknown) => {
          icons.delete(path);
          console.warn("Application icon unavailable", error);
          return null;
        });
      icons.set(path, icon);
    }
    return icon;
  });
  ipcMain.on("launcher:resize", (event, count: unknown, mode: unknown) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) return;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 30) return;
    if (mode !== undefined && mode !== "clipboard") return;
    onModeChange(mode === "clipboard" ? "clipboard" : "search");
    window.setSize(800, mode === "clipboard" ? 580 : launcherHeight(count));
  });
}
