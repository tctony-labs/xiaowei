import {
  type AgentEvent,
  type AgentItem,
  AgentItemField,
  AgentRunStatus,
  type AgentSession,
  AgentSessionStatus,
} from "proto-desktop-ts";
import type { QuickChatMessage } from "../quick-chat/QuickChatPanel";
import { messageBlocks } from "./message-blocks";

export function applyAgentEvent(
  current: AgentSession | undefined,
  event: AgentEvent,
): AgentSession | undefined {
  const { payload } = event;
  if (payload.case === "subscriptionReady") return payload.value.session;
  if (
    !payload.case ||
    !current ||
    !("sessionId" in payload.value) ||
    payload.value.sessionId !== current.sessionId
  )
    return current;
  const session = { ...current, runs: [...current.runs] };
  if (payload.case === "sessionDeleted") return undefined;
  if (payload.case === "sessionArchivedUpdated") {
    if (payload.value.archived) return undefined;
    session.archived = false;
    session.archiveRevision = payload.value.archiveRevision;
  }
  if (payload.case === "sessionTitleUpdated") {
    session.title = payload.value.title;
    session.titleModelRef = payload.value.titleModelRef;
    session.autoTitleEnabled = payload.value.autoTitleEnabled;
    session.metadataRevision = payload.value.metadataRevision;
    session.updatedAtMs =
      payload.value.updatedAtMs > session.updatedAtMs
        ? payload.value.updatedAtMs
        : session.updatedAtMs;
  } else if (payload.case === "sessionConfigUpdated") {
    session.config = payload.value.config;
    session.providerName = payload.value.providerName;
    session.modelName = payload.value.modelName;
    session.metadataRevision = payload.value.metadataRevision;
  } else if (payload.case === "sessionModelInfoWarningUpdated") {
    session.modelInfoWarning = payload.value.warning;
    session.providerName = payload.value.providerName;
    session.modelName = payload.value.modelName;
  } else if (payload.case === "runStarted") {
    if (!payload.value.run) throw new Error("Missing accepted run");
    if (!session.runs.some((run) => run.runId === payload.value.run?.runId))
      session.runs.push(payload.value.run);
    session.metadataRevision = payload.value.sessionMetadataRevision;
    session.titleModelRef = payload.value.titleModelRef;
    session.status = AgentSessionStatus.RUNNING;
    session.updatedAtMs = payload.value.run.startedAtMs;
  } else if (payload.case === "runCompleted") {
    const final = payload.value.run;
    const index = session.runs.findIndex((run) => run.runId === final?.runId);
    if (!final || index < 0) throw new Error("Unknown completed run");
    const previous = session.runs[index];
    const completeFrame = !final.itemsContinuation && !previous.itemsContinuation;
    session.runs[index] = {
      ...final,
      items: mergeItems(
        completeFrame
          ? previous.items.filter((item) => final.items.some((part) => part.itemId === item.itemId))
          : previous.items,
        final.items,
        true,
      ),
      itemsContinuation: previous.itemsContinuation,
      itemsContinuationIsOlder: previous.itemsContinuationIsOlder,
    };
    session.status = AgentSessionStatus.IDLE;
    if (final.completedAtMs !== undefined && final.completedAtMs > session.updatedAtMs) {
      session.updatedAtMs = final.completedAtMs;
    }
  } else if (payload.case === "interactionUpdated") {
    const runIndex = session.runs.findIndex((run) => run.runId === payload.value.runId);
    const run = session.runs[runIndex];
    const itemIndex =
      run?.items.findIndex(
        (item) =>
          item.content.case === "toolCall" && item.content.value.toolId === payload.value.toolId,
      ) ?? -1;
    const item = run?.items[itemIndex];
    if (item?.content.case !== "toolCall" || !payload.value.interaction) {
      throw new Error("Unknown interaction tool");
    }
    const items = [...run.items];
    items[itemIndex] = {
      ...item,
      content: {
        case: "toolCall",
        value: { ...item.content.value, interaction: payload.value.interaction },
      },
    };
    session.runs[runIndex] = { ...run, items };
  } else if (payload.case === "generationUpdated") {
    const index = session.runs.findIndex((run) => run.runId === payload.value.runId);
    const run = session.runs[index];
    if (!run) throw new Error("Unknown generation run");
    session.runs[index] = { ...run, generation: payload.value.generation };
  } else if (
    ["itemStarted", "itemCompleted", "agentMessageDelta", "reasoningDelta"].includes(
      payload.case ?? "",
    )
  ) {
    if (!payload.case || !("runId" in payload.value)) return current;
    const runId = payload.value.runId;
    const runIndex = session.runs.findIndex((run) => run.runId === runId);
    const run = session.runs[runIndex];
    if (!run) throw new Error("Unknown event run");
    const items = [...run.items];
    if (payload.case === "itemStarted" || payload.case === "itemCompleted") {
      const item = payload.value.item;
      if (!item) throw new Error("Missing item");
      const index = run.items.findIndex((existing) => existing.itemId === item.itemId);
      const previous = items[index];
      if (index < 0) {
        const last = items.at(-1);
        items.push({
          ...item,
          historyIndex:
            item.historyIndex ?? (last ? (last.historyIndex ?? items.length - 1) + 1 : 0),
        });
        if (item.historyIndex !== undefined && item.historyIndex < (last?.historyIndex ?? 0)) {
          items.sort((left, right) => (left.historyIndex ?? 0) - (right.historyIndex ?? 0));
        }
      } else {
        items[index] = { ...item, historyIndex: item.historyIndex ?? previous.historyIndex };
      }
    } else if (payload.case === "agentMessageDelta" || payload.case === "reasoningDelta") {
      const index = items.findIndex((item) => item.itemId === payload.value.itemId);
      const item = items[index];
      if (!item) throw new Error("Unknown delta item");
      if (item.shortenedFields.includes(AgentItemField.TEXT)) return current;
      if (item.content.case === "agentMessage" || item.content.case === "reasoning") {
        const value = {
          ...item.content.value,
          text: item.content.value.text + payload.value.delta,
        };
        items[index] = { ...item, content: { ...item.content, value } } as AgentItem;
      } else throw new Error("Invalid delta item");
    }
    session.runs[runIndex] = { ...run, items };
  }
  return session;
}

export function mergeItems(current: AgentItem[], page: AgentItem[], terminal = false): AgentItem[] {
  const items = new Map(current.map((item, index) => [item.itemId, { item, index }]));
  for (const item of page) {
    const previous = items.get(item.itemId);
    if (!previous || terminal) {
      const display =
        previous && item.shortenedFields.length > previous.item.shortenedFields.length
          ? previous.item
          : item;
      items.set(item.itemId, {
        item: display,
        index: item.historyIndex ?? previous?.index ?? items.size,
      });
    }
  }
  return [...items.values()]
    .sort(
      (left, right) =>
        (left.item.historyIndex ?? left.index) - (right.item.historyIndex ?? right.index),
    )
    .map(({ item }) => item);
}

export function chatMessages(session?: AgentSession): QuickChatMessage[] {
  return (session?.runs ?? []).flatMap((run) => {
    const user = run.items.find((item) => item.content.case === "userMessage");
    const userText =
      user?.content.case === "userMessage"
        ? user.content.value.content
            .flatMap((input) => (input.content.case === "text" ? [input.content.value] : []))
            .join("\n")
        : "";
    const status =
      run.status === AgentRunStatus.IN_PROGRESS
        ? "generating"
        : run.status === AgentRunStatus.COMPLETED
          ? "complete"
          : run.status === AgentRunStatus.INTERRUPTED
            ? "cancelled"
            : "failed";
    return [
      { id: run.inputId, role: "user", text: userText, timestampMs: run.startedAtMs },
      {
        id: run.runId,
        role: "assistant",
        timestampMs: run.startedAtMs,
        blocks: messageBlocks(run.items),
        moreItems: run.itemsContinuation
          ? run.itemsContinuationIsOlder
            ? "older"
            : "newer"
          : undefined,
        generation:
          run.status === AgentRunStatus.IN_PROGRESS && run.generation
            ? {
                id: run.generation.genId,
                startedAtMs: Number(run.generation.startedAtMs),
                receivedContent: run.generation.receivedContent,
                activeBlockId: run.generation.activeItemId,
              }
            : undefined,
        finalResponseBlockIds:
          run.status === AgentRunStatus.COMPLETED && run.finalGenId !== undefined
            ? run.items
                .filter(
                  (item) => item.genId === run.finalGenId && item.content.case === "agentMessage",
                )
                .map((item) => item.itemId)
            : undefined,
        durationMs:
          run.completedAtMs !== undefined && run.completedAtMs >= run.startedAtMs
            ? run.completedAtMs - run.startedAtMs
            : undefined,
        status,
        error:
          status === "failed" ? run.error || "模型请求失败，请检查模型配置后重试。" : undefined,
      },
    ] satisfies QuickChatMessage[];
  });
}
