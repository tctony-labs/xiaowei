import { contextBridge } from "electron";
import { gateway } from "./gateway";

contextBridge.exposeInMainWorld("gateway", gateway);
