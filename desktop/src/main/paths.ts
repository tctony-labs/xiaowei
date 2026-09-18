import { join } from "node:path";

// Main owns application directories; native modules own files within their supplied directory.
export function createPaths(systemAppData: string) {
  const userData = join(systemAppData, "com.tctony.xiaowei");
  const appData = join(userData, "xiaowei");
  return {
    userData,
    appData,
    logs: join(appData, "logs"),
    clipboard: join(appData, "clipboard"),
  } as const;
}
