import { contextBridge, ipcRenderer } from "electron";
import { createPreloadBridge } from "xiaowei-gateway/preload";

const bridge = createPreloadBridge({
  invoke: (_channel, message) => ipcRenderer.invoke("xiaowei:gateway:acceptance", message),
  on: (...args) => ipcRenderer.on(...args),
  removeListener: (...args) => ipcRenderer.removeListener(...args),
});
contextBridge.exposeInMainWorld("gateway", bridge);
