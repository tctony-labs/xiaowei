import type { AgentItem, AgentToolCall } from "xiaowei-contracts";

export type AgentMessageBlock =
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "reasoning"; text: string }
  | { id: string; kind: "tool"; call: AgentToolCall };

export type AgentToolBlock = Extract<AgentMessageBlock, { kind: "tool" }>;

// Supplied by the page adapter; a tool declaration is not a running tool Item.
export interface AgentGenerationState {
  id: string;
  startedAtMs: number;
  receivedContent: boolean;
  activeBlockId?: string;
}

export type AgentMessageGroup =
  | Exclude<AgentMessageBlock, AgentToolBlock>
  | { id: string; kind: "tools"; blocks: AgentToolBlock[] };

export function groupMessageBlocks(blocks: AgentMessageBlock[]): AgentMessageGroup[] {
  const groups: AgentMessageGroup[] = [];

  for (const block of blocks) {
    if (block.kind !== "tool") {
      if (block.text.trim()) groups.push(block);
      continue;
    }

    const previous = groups.at(-1);
    if (previous?.kind === "tools") {
      previous.blocks.push(block);
    } else {
      groups.push({ id: block.id, kind: "tools", blocks: [block] });
    }
  }

  return groups;
}

export function lastReasoningLine(text: string): string {
  const lines = text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .trimEnd()
    .split(/\r?\n/);
  return (
    lines
      .reverse()
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

export function messageBlocks(items: AgentItem[]): AgentMessageBlock[] {
  return items.flatMap((item): AgentMessageBlock[] => {
    switch (item.content.case) {
      case "agentMessage":
        return [{ id: item.itemId, kind: "text", text: item.content.value.text }];
      case "reasoning":
        return [{ id: item.itemId, kind: "reasoning", text: item.content.value.text }];
      case "toolCall":
        return [{ id: item.itemId, kind: "tool", call: item.content.value }];
      default:
        return [];
    }
  });
}
