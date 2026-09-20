import { ipcRenderer } from "electron";
import { createPreloadBridge } from "xiaowei-gateway/preload";
export const gateway = createPreloadBridge(ipcRenderer);
