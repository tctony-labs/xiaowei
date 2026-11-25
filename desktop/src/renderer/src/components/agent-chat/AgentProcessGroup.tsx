import { AgentToolStatus } from "proto-desktop-ts";
import { useEffect, useId, useRef, useState } from "react";
import { AgentItemPreviewButton } from "./AgentItemPreviewButton";
import { AgentReasoning } from "./AgentReasoning";
import { AgentToolCall } from "./AgentToolCall";
import type { AgentWebLinkProps } from "./AgentWebResult";
import type { AgentProcessBlock, LoadAgentItem } from "./message-blocks";
import { reasoningPreview } from "./reasoning-preview";
import { toolGroupPresentation } from "./tool-presentation";

export function AgentProcessGroup({
  blocks,
  complete = false,
  activeBlockId,
  onOpenUrl,
  onLoadItem,
  openItems,
}: {
  blocks: AgentProcessBlock[];
  complete?: boolean;
  activeBlockId?: string;
  onLoadItem?: LoadAgentItem;
  openItems?: Set<string>;
} & AgentWebLinkProps) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(() => blocks.some((block) => openItems?.has(block.id)));
  const wasComplete = useRef(complete);
  const multiple = blocks.length > 1;
  const calls = blocks.flatMap((block) => (block.kind === "tool" ? [block.call] : []));
  const tools = toolGroupPresentation(calls);
  const activeBlock = complete ? undefined : blocks.find((block) => block.id === activeBlockId);
  const activeReasoning = activeBlock?.kind === "reasoning" ? activeBlock : undefined;
  const active = !complete && (tools.active || !!activeReasoning);
  const label = activeReasoning
    ? `正在思考 ${reasoningPreview(activeReasoning.text)}`.trimEnd()
    : tools.label || "思考过程";
  const failures = calls.filter(
    (call) =>
      call.status === AgentToolStatus.FAILED || call.status === AgentToolStatus.RESULT_UNKNOWN,
  ).length;
  const cancelled = calls.some((call) => call.status === AgentToolStatus.CANCELLED);

  useEffect(() => {
    if (complete && !wasComplete.current) {
      setExpanded(false);
      for (const block of blocks) openItems?.delete(block.id);
    }
    wasComplete.current = complete;
  }, [blocks, complete, openItems]);

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
          onClick={() => {
            setExpanded(!expanded);
            for (const block of blocks) {
              if (expanded) openItems?.delete(block.id);
              else openItems?.add(block.id);
            }
          }}
        >
          <span className="agent-process-disclosure" aria-hidden="true" />
          <span className={`min-w-0 truncate${active ? " agent-shimmer" : ""}`} title={label}>
            {label}
          </span>
          {!active && cancelled && <span>· 已停止</span>}
          {failures > 0 && <span className="text-danger">· {failures} 项异常</span>}
        </button>
      )}
      <div id={contentId} className="agent-process-group-content" hidden={multiple && !expanded}>
        {blocks.map((block) => {
          const fields = block.shortenedFields;
          const load =
            fields?.length && onLoadItem ? () => onLoadItem(block.id, fields) : undefined;
          return block.kind === "reasoning" ? (
            <div key={block.id} data-chat-anchor={block.id}>
              <AgentReasoning text={block.text} active={!complete && block.id === activeBlockId} />
              {load && <AgentItemPreviewButton onLoad={load} />}
            </div>
          ) : (
            <div key={block.id} data-chat-anchor={block.id}>
              <AgentToolCall call={block.call} onOpenUrl={onOpenUrl} onLoadFull={load} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
