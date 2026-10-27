import { AgentToolStatus, type AgentToolCall as ToolCall } from "proto-desktop-ts";
import { AgentTodoList } from "./AgentTodoList";
import { AgentToolIcon } from "./AgentToolIcon";
import { type AgentWebCallbacks, AgentWebResult } from "./AgentWebResult";
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
  onCopy,
  onOpenUrl,
}: {
  call: ToolCall;
  defaultOpen?: boolean;
} & AgentWebCallbacks) {
  const status = statusLabels[call.status] ?? "状态未知";
  const active = call.status === AgentToolStatus.PENDING;
  const showStatus = !active && call.status !== AgentToolStatus.COMPLETED;
  const presentation = toolPresentation(call);
  const args = parseToolJson(call.argumentsJson);
  const parameters = args === undefined ? call.argumentsJson : JSON.stringify(args, null, 2);
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
        {showStatus && <span className="agent-tool-status">{status}</span>}
        <span className="agent-disclosure" aria-hidden="true">
          ›
        </span>
      </summary>
      <div className="agent-tool-details">
        {call.name === "WebFetch" || call.name === "WebSearch" ? (
          <AgentWebResult call={call} onCopy={onCopy} onOpenUrl={onOpenUrl} />
        ) : todos !== undefined ? (
          <AgentTodoList todos={todos} />
        ) : (
          <>
            <div>
              <h4>参数</h4>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard scrolling. */}
              <section className="agent-tool-scroll" aria-label="工具参数" tabIndex={0}>
                <pre>{parameters || "无参数"}</pre>
              </section>
            </div>
            <div>
              <h4>输出</h4>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard scrolling. */}
              <section className="agent-tool-scroll" aria-label="工具输出" tabIndex={0}>
                <pre>
                  {call.output ||
                    (call.status === AgentToolStatus.PENDING ? "等待执行结果…" : "无输出")}
                </pre>
              </section>
            </div>
          </>
        )}
        {typeof diff?.unified === "string" && (
          <div>
            <h4>
              改动
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
