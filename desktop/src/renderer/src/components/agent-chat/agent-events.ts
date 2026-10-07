import { clone } from "@bufbuild/protobuf";
import {
  type AgentEvent,
  AgentRunStatus,
  type AgentSession,
  AgentSessionSchema,
  AgentSessionStatus,
} from "xiaowei-contracts";
import type { QuickChatMessage } from "../quick-chat/QuickChatPanel";

export function applyAgentEvent(current: AgentSession | undefined, event: AgentEvent): AgentSession | undefined {
  const { payload } = event;
  if (payload.case === "subscriptionReady") return payload.value.session;
  if (!payload.case || !current || !("sessionId" in payload.value) || payload.value.sessionId !== current.sessionId)
    return current;
  const session = clone(AgentSessionSchema, current);
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
      payload.value.updatedAtMs > session.updatedAtMs ? payload.value.updatedAtMs : session.updatedAtMs;
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
    if (!session.runs.some((run) => run.runId === payload.value.run?.runId)) session.runs.push(payload.value.run);
    session.metadataRevision = payload.value.sessionMetadataRevision;
    session.titleModelRef = payload.value.titleModelRef;
    session.status = AgentSessionStatus.RUNNING;
    session.updatedAtMs = payload.value.run.startedAtMs;
  } else if (payload.case === "runCompleted") {
    const final = payload.value.run;
    const index = session.runs.findIndex((run) => run.runId === final?.runId);
    if (!final || index < 0) throw new Error("Unknown completed run");
    session.runs[index] = final;
    session.status = AgentSessionStatus.IDLE;
    if (final.completedAtMs !== undefined && final.completedAtMs > session.updatedAtMs) {
      session.updatedAtMs = final.completedAtMs;
    }
  } else if (["itemStarted", "itemCompleted", "agentMessageDelta", "reasoningDelta"].includes(payload.case ?? "")) {
    if (!payload.case || !("runId" in payload.value)) return current;
    const runId = payload.value.runId;
    const run = session.runs.find((run) => run.runId === runId);
    if (!run) throw new Error("Unknown event run");
    if (payload.case === "itemStarted" || payload.case === "itemCompleted") {
      const item = payload.value.item;
      if (!item) throw new Error("Missing item");
      const index = run.items.findIndex((existing) => existing.itemId === item.itemId);
      if (index < 0) run.items.push(item);
      else run.items[index] = item;
    } else if (payload.case === "agentMessageDelta" || payload.case === "reasoningDelta") {
      const item = run.items.find((item) => item.itemId === payload.value.itemId);
      if (!item) throw new Error("Unknown delta item");
      if (item.content.case === "agentMessage" || item.content.case === "reasoning") {
        item.content.value.text += payload.value.delta;
      } else throw new Error("Invalid delta item");
    }
  }
  return session;
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
    const text = run.items
      .flatMap((item) => (item.content.case === "agentMessage" ? [item.content.value.text] : []))
      .join("");
    const thinking = run.items
      .flatMap((item) => (item.content.case === "reasoning" ? [item.content.value.text] : []))
      .join("");
    const status =
      run.status === AgentRunStatus.IN_PROGRESS
        ? "generating"
        : run.status === AgentRunStatus.COMPLETED
          ? "complete"
          : run.status === AgentRunStatus.INTERRUPTED
            ? "cancelled"
            : "failed";
    return [
      { id: run.inputId, role: "user", text: userText },
      {
        id: run.runId,
        role: "assistant",
        text,
        thinking,
        status,
        error: status === "failed" ? run.error || "模型请求失败，请检查模型配置后重试。" : undefined,
      },
    ] satisfies QuickChatMessage[];
  });
}
