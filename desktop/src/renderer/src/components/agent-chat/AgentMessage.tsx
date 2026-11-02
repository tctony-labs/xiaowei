import { type ReactNode, useEffect, useId, useState } from "react";
import type { QuickChatMessage } from "../quick-chat/QuickChatPanel";
import { AgentCopyButton } from "./AgentCopyButton";
import { AgentInteraction } from "./AgentInteraction";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentMessageTime } from "./AgentMessageTime";
import { AgentProcessGroup } from "./AgentProcessGroup";
import { AgentToolCall } from "./AgentToolCall";
import {
  type AgentGenerationState,
  groupMessageBlocks,
  type InteractionControls,
} from "./message-blocks";

interface AgentMessageProps {
  message: QuickChatMessage;
  generation?: AgentGenerationState;
  finalResponseBlockIds?: string[];
  onCopy: (text: string) => Promise<void>;
  onOpenUrl: (url: string) => Promise<void>;
  interactions?: InteractionControls;
}

export function AgentMessage({
  message,
  generation,
  finalResponseBlockIds,
  onCopy,
  onOpenUrl,
  interactions,
}: AgentMessageProps) {
  const activityId = useId();
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [waitingGeneration, setWaitingGeneration] = useState("");
  const generating = message.status === "generating";
  const runStartedAtMs =
    message.timestampMs === undefined ? undefined : Number(message.timestampMs);
  const waitingForContent = generating && generation && !generation.receivedContent;
  const generationId = generation?.id;
  const generationStartedAtMs = generation?.startedAtMs;
  const generationKey = `${generationId}:${generationStartedAtMs}`;

  useEffect(() => {
    if (message.role !== "assistant" || !generating || runStartedAtMs === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [message.role, generating, runStartedAtMs]);

  useEffect(() => {
    if (!waitingForContent || generationStartedAtMs === undefined) return;
    const delay = Math.max(0, generationStartedAtMs + 3000 - Date.now());
    const timer = setTimeout(() => setWaitingGeneration(generationKey), delay);
    return () => clearTimeout(timer);
  }, [waitingForContent, generationStartedAtMs, generationKey]);

  if (message.role === "user") {
    return (
      <div className="agent-message items-end">
        <p className="max-w-full rounded-xl bg-hover px-3 py-2 whitespace-pre-wrap break-words">
          {message.text}
        </p>
        <div className="agent-message-actions">
          <AgentCopyButton text={message.text ?? ""} label="复制消息" onCopy={onCopy} />
          <AgentMessageTime timestampMs={message.timestampMs} />
        </div>
      </div>
    );
  }

  const blocks = message.blocks ?? [];
  const groups = groupMessageBlocks(blocks);
  const lastTodoId = groups
    .slice()
    .reverse()
    .find((group) => group.kind === "todo")?.id;
  const hasFinalResponse = message.status === "complete" && finalResponseBlockIds !== undefined;
  const answerIds = new Set(finalResponseBlockIds);
  const activity = hasFinalResponse ? blocks.filter((block) => !answerIds.has(block.id)) : [];
  const hasActivity = activity.some(
    (block) => block.kind === "tool" || block.kind === "interaction" || !!block.text.trim(),
  );
  const activityIds = new Set(activity.map((block) => block.id));
  const finalElapsedSeconds =
    message.durationMs === undefined
      ? undefined
      : Math.round(Number(message.durationMs) / 100) / 10;
  const elapsedSeconds = generating
    ? runStartedAtMs === undefined
      ? undefined
      : Math.max(0, Math.floor((now - runStartedAtMs) / 1000))
    : finalElapsedSeconds;
  const elapsedLabel =
    elapsedSeconds === undefined
      ? "查看过程"
      : `${generating ? "已用时" : "用时"} ${elapsedSeconds} 秒`;
  const replyBlocks = hasFinalResponse ? blocks.filter((block) => answerIds.has(block.id)) : blocks;
  const reply = replyBlocks
    .flatMap((block) => (block.kind === "text" && block.text ? [block.text] : []))
    .join("\n\n");
  const activeBlockId = generating ? generation?.activeBlockId : undefined;
  const hasActiveContent = groups.some(
    (group) =>
      group.id === activeBlockId ||
      (group.kind === "process" && group.blocks.some((block) => block.id === activeBlockId)),
  );
  const showWaiting =
    waitingForContent &&
    (waitingGeneration === generationKey || Date.now() - generation.startedAtMs >= 3000);

  return (
    <div className="agent-message">
      {(hasActivity || elapsedSeconds !== undefined) && (
        <div className="agent-activity-header">
          {hasActivity ? (
            <button
              type="button"
              className="agent-activity-toggle"
              aria-label={expanded ? "收起执行过程" : "展开执行过程"}
              aria-expanded={expanded}
              aria-controls={groups
                .filter((group) => activityIds.has(group.id))
                .map((group) => `${activityId}-${group.id}`)
                .join(" ")}
              onClick={() => setExpanded(!expanded)}
            >
              <span>{elapsedLabel}</span>
              <span className="agent-disclosure" aria-hidden="true">
                ›
              </span>
            </button>
          ) : (
            <span className="text-xs leading-5 text-muted">{elapsedLabel}</span>
          )}
        </div>
      )}
      <div className="agent-message-blocks">
        {groups.map((group) => {
          let content: ReactNode;
          if (group.kind === "process") {
            content = (
              <AgentProcessGroup
                blocks={group.blocks}
                complete={group.complete || !generating}
                activeBlockId={activeBlockId}
                onCopy={onCopy}
                onOpenUrl={onOpenUrl}
              />
            );
          } else if (group.kind === "todo") {
            content = <AgentToolCall call={group.call} defaultOpen={group.id === lastTodoId} />;
          } else if (group.kind === "interaction") {
            content = <AgentInteraction view={group.interaction} controls={interactions} />;
          } else {
            content = (
              <AgentMarkdown
                text={group.text}
                onCopy={onCopy}
                onOpenUrl={onOpenUrl}
                streaming={group.id === activeBlockId}
              />
            );
          }

          const isActivity = activityIds.has(group.id);
          return (
            <div key={group.id} id={`${activityId}-${group.id}`} hidden={isActivity && !expanded}>
              {content}
            </div>
          );
        })}
      </div>
      {generating && generation && !hasActiveContent && (
        <p
          role="status"
          aria-label={showWaiting ? undefined : "模型正在生成"}
          className="agent-shimmer text-xs text-muted"
        >
          {showWaiting ? "等待模型响应" : "…"}
        </p>
      )}
      {hasFinalResponse && !reply.trim() && <p className="text-xs text-muted">未返回回复内容</p>}
      {message.status === "cancelled" && <p className="text-xs text-muted">已停止</p>}
      {message.error && (
        <p role="alert" className="text-xs text-danger">
          {message.error}
        </p>
      )}
      {message.status !== "generating" && !!(reply.trim() || message.timestampMs) && (
        <div className="agent-message-actions">
          {reply.trim() && <AgentCopyButton text={reply} label="复制回复" onCopy={onCopy} />}
          <AgentMessageTime timestampMs={message.timestampMs} />
        </div>
      )}
    </div>
  );
}
