import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// Main owns application directories; native modules own files within their supplied directory.
export function createPaths(systemAppData: string, env: Readonly<Record<string, string | undefined>> = process.env) {
  const electronRootDir = join(systemAppData, "com.tctony.xiaowei");
  const xiaoweiRootDir = join(electronRootDir, "xiaowei");

  const xiaoweiAgentRootDir = env.XIAOWEI_AGENT_HOME ?? join(homedir(), ".xiaowei");
  if (!isAbsolute(xiaoweiAgentRootDir)) throw new Error("XIAOWEI_AGENT_HOME must be an absolute path");

  // 新增目录或文件路径时按所属根目录分组，组间留空行。
  // 各组按 rootDir 属性名字母序排列；组内 rootDir 在首行，其余属性按名字母序排列。
  return {
    electronRootDir,

    xiaoweiAgentRootDir,
    models: join(xiaoweiAgentRootDir, "models.json"),

    xiaoweiRootDir,
    appIcons: join(xiaoweiRootDir, "cache", "app-icons"),
    auth: join(xiaoweiRootDir, "auth.json"),
    clipboard: join(xiaoweiRootDir, "clipboard"),
    database: join(xiaoweiRootDir, "storage.sqlite"),
    logs: join(xiaoweiRootDir, "logs"),
  } as const;
}
