import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// Main owns application directories; native modules own files within their supplied directory.
export function createPaths(systemAppData: string, env: Readonly<Record<string, string | undefined>> = process.env) {
  const moduleRoot = env.XIAOWEI_AGENT_HOME ?? join(homedir(), ".xiaowei");
  if (!isAbsolute(moduleRoot)) throw new Error("XIAOWEI_AGENT_HOME must be an absolute path");

  const userData = join(systemAppData, "com.tctony.xiaowei");
  const appData = join(userData, "xiaowei");
  return {
    userData,
    appData,
    agent: moduleRoot,
    models: join(moduleRoot, "models.json"),
    database: join(appData, "storage.sqlite"),
    appIcons: join(appData, "cache", "app-icons"),
    logs: join(appData, "logs"),
    clipboard: join(appData, "clipboard"),
  } as const;
}
