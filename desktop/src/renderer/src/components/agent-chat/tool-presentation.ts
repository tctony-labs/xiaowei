import { type AgentToolCall, AgentToolStatus } from "proto-desktop-ts";

export type AgentToolIconKind =
  | "file"
  | "search"
  | "edit"
  | "terminal"
  | "tools"
  | "todo"
  | "question"
  | "permission";

// Keep completed summaries in the reference app's category order, not call order.
const toolActivities = {
  tools: { label: "调用工具", icon: "tools" },
  changes: { label: "修改文件", icon: "edit" },
  exploration: { label: "读取文件", icon: "file" },
  commands: { label: "执行命令", icon: "terminal" },
} satisfies Record<string, { label: string; icon: AgentToolIconKind }>;

const toolActions: Record<
  string,
  {
    action: string;
    summary: string;
    icon: AgentToolIconKind;
    activity: keyof typeof toolActivities;
  }
> = {
  TodoWrite: { action: "更新待办", summary: "更新待办", icon: "todo", activity: "tools" },
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
  const target = isToolObject(args)
    ? [args.pattern, args.path, args.command].find(
        (value): value is string => typeof value === "string" && !!value.trim(),
      )
    : undefined;
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
    const { label, icon } = toolPresentation(activeCall);
    return { label, icon, active: true };
  }

  const activities = new Set<string>(calls.map((call) => toolPresentation(call).activity));
  const summaries = Object.entries(toolActivities)
    .filter(([activity]) => activities.has(activity))
    .map(([, summary]) => summary);

  return {
    label: summaries.map((summary) => summary.label).join("、"),
    icon: summaries[0]?.icon ?? "tools",
    active: false,
  };
}
