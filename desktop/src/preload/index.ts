import { contextBridge, ipcRenderer } from "electron";
import type { ClipboardApi } from "../shared/clipboard-api";
import type { LauncherApi, LauncherMode } from "../shared/launcher-api";

const launcher: LauncherApi = {
  onOpen: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, mode: LauncherMode) => callback(mode);
    ipcRenderer.on("launcher:open", listener);
    return () => ipcRenderer.removeListener("launcher:open", listener);
  },
  hide: () => ipcRenderer.send("launcher:hide"),
  search: (query) => ipcRenderer.invoke("launcher:search", query),
  execute: (token, id) => ipcRenderer.invoke("launcher:execute", token, id),
  resize: (count, mode) => ipcRenderer.send("launcher:resize", count, mode),
  icon: (token, id) => ipcRenderer.invoke("launcher:icon", token, id),
};
contextBridge.exposeInMainWorld("launcher", launcher);

const clipboardHistory: ClipboardApi = {
  resource: (id, action, index) => ipcRenderer.invoke("clipboard:resource", id, action, index),
  openUrl: (url) => ipcRenderer.invoke("clipboard:openUrl", url),
  categories: () => ipcRenderer.invoke("clipboard:categories"),
  saveCategory: (name, color, id) => ipcRenderer.invoke("clipboard:saveCategory", name, color, id),
  deleteCategory: (id) => ipcRenderer.invoke("clipboard:deleteCategory", id),
  setRemark: (id, remark) => ipcRenderer.invoke("clipboard:setRemark", id, remark),
  setCategory: (id, category) => ipcRenderer.invoke("clipboard:setCategory", id, category),
  editText: (id, text) => ipcRenderer.invoke("clipboard:editText", id, text),
  list: (options) => ipcRenderer.invoke("clipboard:list", options),
  get: (id) => ipcRenderer.invoke("clipboard:get", id),
  readText: (id) => ipcRenderer.invoke("clipboard:readText", id),
  readImage: (id) => ipcRenderer.invoke("clipboard:readImage", id),
  copy: (id) => ipcRenderer.invoke("clipboard:copy", id),
  delete: (id) => ipcRenderer.invoke("clipboard:delete", id),
  setFavorite: (id, favorite) => ipcRenderer.invoke("clipboard:setFavorite", id, favorite),
  clearHistory: () => ipcRenderer.invoke("clipboard:clearHistory"),
  onChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("clipboard:changed", listener);
    return () => ipcRenderer.removeListener("clipboard:changed", listener);
  },
};
contextBridge.exposeInMainWorld("clipboardHistory", clipboardHistory);
