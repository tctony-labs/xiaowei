import { contextBridge, ipcRenderer } from "electron";
import type { LauncherApi } from "../shared/launcher-api";

const launcher: LauncherApi = {
  hide: () => ipcRenderer.send("launcher:hide"),
};
contextBridge.exposeInMainWorld("launcher", launcher);
