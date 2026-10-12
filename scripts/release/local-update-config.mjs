import { join } from "node:path";
import { desktopDirectory } from "./sparkle.mjs";

export const localUpdateName = "XiaoWei Local Update";
export const localUpdateAppId = "com.tctony.xiaowei.local-update";
export const localUpdatePort = 18765;
export const localUpdateOrigin = `http://127.0.0.1:${localUpdatePort}`;
export const localUpdateDirectory = join(desktopDirectory, "dist/local-update");
