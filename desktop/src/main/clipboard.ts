import { mkdtempSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { app, type BrowserWindow, clipboard, type IpcMainInvokeEvent, ipcMain, shell } from "electron";
import { ClipboardHistory, type ClipboardListOptions } from "xiaowei-clipboard";

import { clipboardPaths, clipboardPathText, webUrl } from "./clipboard-files";

function itemId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new Error("Invalid clipboard item ID");
  return value;
}

function listOptions(value: unknown): ClipboardListOptions {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid clipboard options");
  const options = value as Record<string, unknown>;
  if (
    Object.keys(options).some(
      (key) => !["query", "favoritesOnly", "kind", "categoryId", "limit", "offset"].includes(key),
    )
  ) {
    throw new Error("Unknown clipboard option");
  }
  if (options.query !== undefined && (typeof options.query !== "string" || Buffer.byteLength(options.query) > 4096)) {
    throw new Error("Invalid clipboard query");
  }
  if (options.favoritesOnly !== undefined && typeof options.favoritesOnly !== "boolean") {
    throw new Error("Invalid favorite filter");
  }
  if (options.categoryId !== undefined) itemId(options.categoryId);
  if (options.kind !== undefined && options.kind !== "image" && options.kind !== "file") {
    throw new Error("Invalid clipboard kind");
  }
  for (const [key, min, max] of [
    ["limit", 1, 100],
    ["offset", 0, 0xffffffff],
  ] as const) {
    const number = options[key];
    if (
      number !== undefined &&
      (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max)
    ) {
      throw new Error(`Invalid clipboard ${key}`);
    }
  }
  return options as ClipboardListOptions;
}

export function registerClipboard(getWindow: () => BrowserWindow | undefined): void {
  const exportDirectory = mkdtempSync(join(app.getPath("temp"), "xiaowei-clipboard-"));
  app.once("will-quit", () => {
    rmSync(exportDirectory, { recursive: true, force: true });
  });
  let history: ClipboardHistory | undefined;
  let stopping = false;
  const ready = ClipboardHistory.open(join(app.getPath("userData"), "clipboard"), () => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("clipboard:changed");
  }).then((store) => {
    history = store;
    if (!stopping && process.platform === "darwin") store.startMonitoring();
    console.info("Clipboard history ready");
    return store;
  });
  void ready.catch((error: unknown) => console.error("Clipboard initialization failed", error));
  app.once("before-quit", () => {
    stopping = true;
    try {
      history?.stopMonitoring();
    } catch (error) {
      console.error("Clipboard shutdown failed", error);
    }
  });

  function validate(event: IpcMainInvokeEvent): void {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Invalid clipboard caller");
    }
  }
  ipcMain.handle("clipboard:openUrl", async (event, url: unknown) => {
    validate(event);
    await shell.openExternal(webUrl(url));
  });
  ipcMain.handle("clipboard:resource", async (event, id: unknown, action: unknown, index: unknown) => {
    validate(event);
    const key = itemId(id);
    if (typeof action !== "string" || !["open", "reveal", "copyPath", "copyDirectory"].includes(action)) {
      throw new Error("Invalid resource action");
    }
    if (index !== undefined && (typeof index !== "number" || !Number.isInteger(index) || index < 0)) {
      throw new Error("Invalid file index");
    }
    const paths = await clipboardPaths(await ready, exportDirectory, key, index as number | undefined);
    if (action === "copyPath" || action === "copyDirectory") {
      clipboard.writeText(clipboardPathText(paths, action === "copyDirectory"));
      return;
    }
    if (action === "open" && paths.length !== 1) throw new Error("Select a single file to open");
    for (const path of paths) {
      await access(path);
      if (action === "reveal") shell.showItemInFolder(path);
      else {
        const error = await shell.openPath(path);
        if (error) throw new Error(error);
      }
    }
  });
  ipcMain.handle("clipboard:list", async (event, options: unknown) => {
    validate(event);
    const filter = listOptions(options);
    return (await ready).list(filter);
  });
  for (const method of ["get", "readText", "readImage", "copy", "delete", "deleteCategory"] as const) {
    ipcMain.handle(`clipboard:${method}`, async (event, id: unknown) => {
      validate(event);
      const key = itemId(id);
      const store = await ready;
      return store[method](key);
    });
  }
  ipcMain.handle("clipboard:categories", async (event) => {
    validate(event);
    return (await ready).categories();
  });
  ipcMain.handle("clipboard:saveCategory", async (event, name: unknown, color: unknown, id: unknown) => {
    validate(event);
    if (
      typeof name !== "string" ||
      Buffer.byteLength(name) > 256 ||
      typeof color !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(color)
    )
      throw new Error("Invalid category");
    const key = id === undefined ? undefined : itemId(id);
    return (await ready).saveCategory(name, color, key);
  });
  ipcMain.handle("clipboard:setCategory", async (event, id: unknown, category: unknown) => {
    validate(event);
    const key = itemId(id);
    const categoryId = category === undefined ? undefined : itemId(category);
    return (await ready).setCategory(key, categoryId);
  });
  for (const method of ["editText", "setRemark"] as const) {
    ipcMain.handle(`clipboard:${method}`, async (event, id: unknown, value: unknown) => {
      validate(event);
      const key = itemId(id);
      if (typeof value !== "string" || (method === "setRemark" && Buffer.byteLength(value) > 65536)) {
        throw new Error("Invalid clipboard text");
      }
      return (await ready)[method](key, value);
    });
  }
  ipcMain.handle("clipboard:setFavorite", async (event, id: unknown, favorite: unknown) => {
    validate(event);
    const key = itemId(id);
    if (typeof favorite !== "boolean") throw new Error("Invalid favorite value");
    return (await ready).setFavorite(key, favorite);
  });
  ipcMain.handle("clipboard:clearHistory", async (event) => {
    validate(event);
    return (await ready).clearHistory();
  });
}
