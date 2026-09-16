import { contextBridge, ipcRenderer } from "electron";
import type { LauncherApi } from "../shared/launcher-api";

const launcher: LauncherApi = {
  hide: () => ipcRenderer.send("launcher:hide"),
  search: (query) => ipcRenderer.invoke("launcher:search", query),
  execute: (token, id) => ipcRenderer.invoke("launcher:execute", token, id),
  resize: (count) => ipcRenderer.send("launcher:resize", count),
  icon: (token, id) => ipcRenderer.invoke("launcher:icon", token, id),
};
contextBridge.exposeInMainWorld("launcher", launcher);
