import { useId, useState } from "react";
import { AgentToolStatus } from "xiaowei-contracts";
import { AgentToolCall } from "./AgentToolCall";
import { AgentToolIcon } from "./AgentToolIcon";
import type { AgentToolBlock } from "./message-blocks";
import { toolGroupPresentation } from "./tool-presentation";

export function AgentToolGroup({ blocks }: { blocks: AgentToolBlock[] }) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const multiple = blocks.length > 1;
  const { label, icon, active } = toolGroupPresentation(blocks.map((block) => block.call));
  const failures = blocks.filter(
    (block) =>
      block.call.status === AgentToolStatus.FAILED ||
      block.call.status === AgentToolStatus.RESULT_UNKNOWN,
  ).length;
  const cancelled = blocks.some((block) => block.call.status === AgentToolStatus.CANCELLED);

  return (
    <div className="agent-tool-group">
      {multiple && (
        <button
          type="button"
          className="agent-activity-toggle"
          aria-label={expanded ? "收起工具调用" : "展开工具调用"}
          aria-expanded={expanded}
          aria-busy={active}
          aria-controls={contentId}
          onClick={() => setExpanded(!expanded)}
        >
          <AgentToolIcon kind={icon} />
          <span className={`min-w-0 truncate${active ? " agent-shimmer" : ""}`} title={label}>
            {label}
          </span>
          {!active && cancelled && <span>· 已停止</span>}
          {failures > 0 && <span className="text-danger">· {failures} 项异常</span>}
          <span className="agent-disclosure" aria-hidden="true">
            ›
          </span>
        </button>
      )}
      <div id={contentId} className="agent-tool-group-content" hidden={multiple && !expanded}>
        {blocks.map((block) => (
          <AgentToolCall key={block.id} call={block.call} />
        ))}
      </div>
    </div>
  );
}
