import { AgentToolStatus } from "proto-desktop-ts";
import { useEffect, useId, useState } from "react";
import { AgentReasoning, AgentReasoningPreview } from "./AgentReasoning";
import { AgentToolCall } from "./AgentToolCall";
import { AgentToolIcon } from "./AgentToolIcon";
import type { AgentWebCallbacks } from "./AgentWebResult";
import { type AgentProcessBlock, lastReasoningLine } from "./message-blocks";
import { toolGroupPresentation } from "./tool-presentation";

export function AgentProcessGroup({
  blocks,
  complete = false,
  activeBlockId,
  onCopy,
  onOpenUrl,
}: {
  blocks: AgentProcessBlock[];
  complete?: boolean;
  activeBlockId?: string;
} & AgentWebCallbacks) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const multiple = blocks.length > 1;
  const calls = blocks.flatMap((block) => (block.kind === "tool" ? [block.call] : []));
  const tools = toolGroupPresentation(calls);
  const activeBlock = complete ? undefined : blocks.find((block) => block.id === activeBlockId);
  const activeReasoning = activeBlock?.kind === "reasoning" ? activeBlock : undefined;
  const active = !complete && (tools.active || !!activeReasoning);
  const label = activeReasoning
    ? `正在思考 ${lastReasoningLine(activeReasoning.text)}`
    : tools.label || "思考过程";
  const failures = calls.filter(
    (call) =>
      call.status === AgentToolStatus.FAILED || call.status === AgentToolStatus.RESULT_UNKNOWN,
  ).length;
  const cancelled = calls.some((call) => call.status === AgentToolStatus.CANCELLED);

  useEffect(() => {
    if (complete) setExpanded(false);
  }, [complete]);

  return (
    <div className="agent-process-group">
      {multiple && (
        <button
          type="button"
          className="agent-activity-toggle"
          aria-label={expanded ? "收起过程组" : "展开过程组"}
          aria-expanded={expanded}
          aria-busy={active}
          aria-controls={contentId}
          onClick={() => setExpanded(!expanded)}
        >
          <AgentToolIcon kind={activeReasoning ? "tools" : tools.icon} />
          <span className={`min-w-0 truncate${active ? " agent-shimmer" : ""}`} title={label}>
            {activeReasoning ? (
              <>
                正在思考 <AgentReasoningPreview text={activeReasoning.text} />
              </>
            ) : (
              label
            )}
          </span>
          {!active && cancelled && <span>· 已停止</span>}
          {failures > 0 && <span className="text-danger">· {failures} 项异常</span>}
          <span className="agent-disclosure" aria-hidden="true">
            ›
          </span>
        </button>
      )}
      <div id={contentId} className="agent-process-group-content" hidden={multiple && !expanded}>
        {blocks.map((block) =>
          block.kind === "reasoning" ? (
            <AgentReasoning
              key={block.id}
              text={block.text}
              active={!complete && block.id === activeBlockId}
            />
          ) : (
            <AgentToolCall key={block.id} call={block.call} onCopy={onCopy} onOpenUrl={onOpenUrl} />
          ),
        )}
      </div>
    </div>
  );
}
