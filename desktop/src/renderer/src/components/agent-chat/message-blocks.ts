import type { AgentInteraction, AgentItem, AgentToolCall } from "proto-desktop-ts";

export interface InteractionForm {
  text: string;
  selectedIndices: number[];
  submitting: boolean;
  uncertain: boolean;
  error: string;
}

export interface InteractionControls {
  form: (id: string) => InteractionForm;
  onTextChange: (id: string, text: string) => void;
  onSelectionChange: (id: string, indices: number[]) => void;
  onRespond: (id: string, allow?: boolean) => void;
}

export type AgentMessageBlock =
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "reasoning"; text: string }
  | { id: string; kind: "tool"; call: AgentToolCall }
  | { id: string; kind: "interaction"; interaction: AgentInteraction };

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
  | { id: string; kind: "todo"; call: AgentToolCall }
  | { id: string; kind: "tools"; blocks: AgentToolBlock[] };

export function groupMessageBlocks(blocks: AgentMessageBlock[]): AgentMessageGroup[] {
  const groups: AgentMessageGroup[] = [];

  for (const block of blocks) {
    if (block.kind !== "tool") {
      if (block.kind === "interaction" || block.text.trim()) groups.push(block);
      continue;
    }

    if (block.call.name === "TodoWrite") {
      groups.push({ id: block.id, kind: "todo", call: block.call });
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
        if (item.content.value.interaction?.request.case) {
          return [
            { id: item.itemId, kind: "interaction", interaction: item.content.value.interaction },
          ];
        }
        return [{ id: item.itemId, kind: "tool", call: item.content.value }];
      default:
        return [];
    }
  });
}
