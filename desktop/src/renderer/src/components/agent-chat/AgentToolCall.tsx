import { AgentToolStatus, type AgentToolCall as ToolCall } from "proto-desktop-ts";
import { AgentTodoList } from "./AgentTodoList";
import { AgentToolIcon } from "./AgentToolIcon";
import { type AgentWebLinkProps, AgentWebResult } from "./AgentWebResult";
import { readTodos } from "./todo-presentation";
import { isToolObject, parseToolJson, toolPresentation } from "./tool-presentation";

const statusLabels: Record<number, string> = {
  [AgentToolStatus.PENDING]: "执行中",
  [AgentToolStatus.COMPLETED]: "已完成",
  [AgentToolStatus.FAILED]: "失败",
  [AgentToolStatus.CANCELLED]: "已停止",
  [AgentToolStatus.SKIPPED]: "未执行",
  [AgentToolStatus.RESULT_UNKNOWN]: "结果未知",
};

export function AgentToolCall({
  call,
  defaultOpen,
  onOpenUrl,
}: {
  call: ToolCall;
  defaultOpen?: boolean;
} & AgentWebLinkProps) {
  const status = statusLabels[call.status] ?? "状态未知";
  const active = call.status === AgentToolStatus.PENDING;
  const showStatus = !active && call.status !== AgentToolStatus.COMPLETED;
  const failedRead = call.name === "Read" && call.status === AgentToolStatus.FAILED;
  const presentation = toolPresentation(call);
  const args = parseToolJson(call.argumentsJson);
  const parameters = args === undefined ? call.argumentsJson : JSON.stringify(args, null, 2);
  const hasParameters =
    !!parameters.trim() && !(isToolObject(args) && Object.keys(args).length === 0);
  const metadata = parseToolJson(call.metadataJson);
  const diff =
    isToolObject(metadata) && isToolObject(metadata.filediff) ? metadata.filediff : undefined;
  const todos =
    call.name === "TodoWrite" && call.status === AgentToolStatus.COMPLETED
      ? readTodos(call.metadataJson)
      : undefined;

  return (
    <details className="agent-tool" data-state={call.status} open={defaultOpen}>
      <summary aria-label={`${presentation.label} · ${status}`} aria-busy={active}>
        <AgentToolIcon kind={presentation.icon} />
        <span
          className={`agent-tool-label${active ? " agent-shimmer" : ""}`}
          title={presentation.target}
        >
          {presentation.label}
        </span>
        {showStatus && (
          <span className="agent-tool-status" title={failedRead ? status : undefined}>
            {failedRead ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="6" />
                <path d="M8 4.8v3.7M8 11.2h.01" />
              </svg>
            ) : (
              status
            )}
          </span>
        )}
        <span className="agent-disclosure" aria-hidden="true">
          ›
        </span>
      </summary>
      <div className="agent-tool-details">
        {call.name === "WebFetch" || call.name === "WebSearch" ? (
          <AgentWebResult call={call} onOpenUrl={onOpenUrl} />
        ) : todos !== undefined ? (
          <AgentTodoList todos={todos} />
        ) : (
          <>
            {hasParameters && (
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard scrolling.
              <section className="agent-tool-scroll" aria-label="工具参数" tabIndex={0}>
                <pre>{parameters}</pre>
              </section>
            )}
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard scrolling. */}
            <section className="agent-tool-scroll" aria-label="工具输出" tabIndex={0}>
              <pre>
                {call.output ||
                  (call.status === AgentToolStatus.PENDING ? "等待执行结果…" : "无输出")}
              </pre>
            </section>
          </>
        )}
        {typeof diff?.unified === "string" && (
          <div>
            <h4>
              diff
              {typeof diff.additions === "number" && <span> +{diff.additions}</span>}
              {typeof diff.deletions === "number" && <span> −{diff.deletions}</span>}
            </h4>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard scrolling for diff. */}
            <section className="agent-tool-scroll" aria-label="文件改动" tabIndex={0}>
              <pre>{diff.unified}</pre>
            </section>
          </div>
        )}
      </div>
    </details>
  );
}
