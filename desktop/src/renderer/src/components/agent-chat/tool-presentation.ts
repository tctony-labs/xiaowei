import { type AgentToolCall, AgentToolStatus } from "proto-desktop-ts";

export type AgentToolIconKind =
  | "file"
  | "web"
  | "search"
  | "edit"
  | "terminal"
  | "tools"
  | "todo"
  | "skill"
  | "question"
  | "permission";

// Keep completed summaries in the reference app's category order, not call order.
const toolActivities = {
  tools: "调用工具",
  changes: "修改文件",
  exploration: "读取文件",
  web: "查阅网页",
  commands: "执行命令",
};

const toolActions: Record<
  string,
  {
    action: string;
    summary: string;
    icon: AgentToolIconKind;
    activity: keyof typeof toolActivities;
  }
> = {
  WebFetch: { action: "读取网页", summary: "读取网页", icon: "web", activity: "web" },
  WebSearch: { action: "搜索网络", summary: "搜索网络", icon: "search", activity: "web" },
  TodoWrite: { action: "更新待办", summary: "更新待办", icon: "todo", activity: "tools" },
  Skill: { action: "加载技能", summary: "加载技能", icon: "skill", activity: "tools" },
  Command: { action: "加载命令", summary: "加载命令", icon: "tools", activity: "tools" },
  AskUserQuestion: { action: "向你提问", summary: "向你提问", icon: "question", activity: "tools" },
  RequestPermission: {
    action: "请求写入权限",
    summary: "请求写入权限",
    icon: "permission",
    activity: "tools",
  },
  Read: { action: "读取", summary: "读取文件", icon: "file", activity: "exploration" },
  Glob: { action: "查找文件", summary: "查找文件", icon: "search", activity: "exploration" },
  Grep: { action: "搜索", summary: "搜索内容", icon: "search", activity: "exploration" },
  Write: { action: "写入", summary: "写入文件", icon: "edit", activity: "changes" },
  Edit: { action: "修改", summary: "修改文件", icon: "edit", activity: "changes" },
  Bash: { action: "执行", summary: "执行命令", icon: "terminal", activity: "commands" },
};

export function parseToolJson(source: string | undefined): unknown {
  try {
    return source ? JSON.parse(source) : undefined;
  } catch {
    return undefined;
  }
}

export function isToolObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolPresentation(call: AgentToolCall) {
  const action = toolActions[call.name] ?? {
    action: `调用 ${call.name}`,
    summary: `调用 ${call.name}`,
    icon: "tools" as const,
    activity: "tools",
  };
  const args = parseToolJson(call.argumentsJson);
  let target: string | undefined;
  if (isToolObject(args)) {
    const targets =
      call.name === "Skill" || call.name === "Command"
        ? [args.name]
        : [args.query, args.url, args.pattern, args.path, args.command];
    target = targets.find((value): value is string => typeof value === "string" && !!value.trim());
  }
  const fileAction = call.name === "Read" || call.name === "Write" || call.name === "Edit";
  const detail =
    fileAction && target ? target.replaceAll("\\", "/").split("/").at(-1) || target : target;

  return {
    label: detail ? `${action.action} ${detail}` : action.summary,
    icon: action.icon,
    target,
    activity: action.activity,
  };
}

export function toolGroupPresentation(calls: AgentToolCall[]) {
  const activeCall = calls
    .slice()
    .reverse()
    .find((call) => call.status === AgentToolStatus.PENDING);
  if (activeCall) {
    return { label: toolPresentation(activeCall).label, active: true };
  }

  const activities = new Set<string>(calls.map((call) => toolPresentation(call).activity));
  const summaries = Object.entries(toolActivities)
    .filter(([activity]) => activities.has(activity))
    .map(([, summary]) => summary);

  return {
    label: summaries.join("、"),
    active: false,
  };
}
