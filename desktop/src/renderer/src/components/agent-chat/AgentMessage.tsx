import { AgentInteractionStatus, AgentItemField, AgentToolStatus } from "proto-desktop-ts";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { QuickChatMessage } from "../quick-chat/QuickChatPanel";
import { AgentCopyButton } from "./AgentCopyButton";
import { AgentInteraction } from "./AgentInteraction";
import { AgentItemPreviewButton } from "./AgentItemPreviewButton";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentMessageTime } from "./AgentMessageTime";
import { AgentProcessGroup } from "./AgentProcessGroup";
import { AgentToolCall } from "./AgentToolCall";
import {
  type AgentGenerationState,
  groupMessageBlocks,
  type InteractionControls,
  type LoadAgentItem,
} from "./message-blocks";

interface AgentMessageProps {
  message: QuickChatMessage;
  generation?: AgentGenerationState;
  finalResponseBlockIds?: string[];
  onCopy: (text: string) => Promise<void>;
  onOpenUrl: (url: string) => void;
  interactions?: InteractionControls;
  onLoadItem?: LoadAgentItem;
  loadMoreItems?: () => void;
  itemPage?: { loading: boolean; error: string };
}

export function AgentMessage({
  message,
  generation,
  finalResponseBlockIds,
  onCopy,
  onOpenUrl,
  interactions,
  onLoadItem,
  loadMoreItems,
  itemPage,
}: AgentMessageProps) {
  const activityId = useId();
  const [expanded, setExpanded] = useState(false);
  const openItems = useRef(new Set<string>());
  const [now, setNow] = useState(Date.now);
  const generating = message.status === "generating";
  const runStartedAtMs =
    message.timestampMs === undefined ? undefined : Number(message.timestampMs);

  useEffect(() => {
    if (message.role !== "assistant" || !generating || runStartedAtMs === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [message.role, generating, runStartedAtMs]);

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
  const hasActivity =
    (hasFinalResponse && !!message.moreItems) ||
    activity.some(
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
  const hasPendingTool = blocks.some(
    (block) =>
      (block.kind === "tool" && block.call.status === AgentToolStatus.PENDING) ||
      (block.kind === "interaction" && block.interaction.status === AgentInteractionStatus.PENDING),
  );
  const showGenerationDots = generating && generation && !hasActiveContent && !hasPendingTool;
  const itemPagination = message.moreItems && loadMoreItems && (!hasFinalResponse || expanded) && (
    <div className="text-xs text-muted">
      <button
        type="button"
        className="agent-history-load"
        onClick={loadMoreItems}
        disabled={itemPage?.loading}
      >
        {itemPage?.loading
          ? "正在加载…"
          : message.moreItems === "older"
            ? "加载更早过程"
            : "加载更多过程"}
      </button>
      {itemPage?.error && <span role="alert"> {itemPage.error}</span>}
    </div>
  );

  async function copyReply() {
    if (!onLoadItem || !replyBlocks.some((block) => block.shortenedFields?.length)) {
      await onCopy(reply);
      return;
    }
    const lines = await Promise.all(
      replyBlocks.flatMap<string | Promise<string>>((block) => {
        if (block.kind !== "text" || !block.text) return [];
        if (!block.shortenedFields?.includes(AgentItemField.TEXT)) return [block.text];
        return [
          onLoadItem(block.id, [AgentItemField.TEXT]).then(
            (result) => result.get(AgentItemField.TEXT) ?? block.text,
          ),
        ];
      }),
    );
    await onCopy(lines.join("\n\n"));
  }

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
            <span className="agent-activity-time text-xs text-muted">{elapsedLabel}</span>
          )}
        </div>
      )}
      <div className="agent-message-blocks">
        {message.moreItems === "older" && itemPagination}
        {groups.map((group) => {
          let content: ReactNode;
          if (group.kind === "process") {
            content = (
              <AgentProcessGroup
                blocks={group.blocks}
                complete={group.complete || !generating}
                activeBlockId={activeBlockId}
                onOpenUrl={onOpenUrl}
                onLoadItem={onLoadItem}
                openItems={openItems.current}
              />
            );
          } else if (group.kind === "todo") {
            const fields = group.shortenedFields;
            content = (
              <AgentToolCall
                call={group.call}
                defaultOpen={group.id === lastTodoId}
                onLoadFull={
                  fields?.length && onLoadItem ? () => onLoadItem(group.id, fields) : undefined
                }
              />
            );
          } else if (group.kind === "interaction") {
            content = (
              <AgentInteraction
                view={group.interaction}
                controls={interactions}
                call={group.call}
              />
            );
          } else {
            const fields = group.shortenedFields;
            content = (
              <>
                <AgentMarkdown
                  text={group.text}
                  onCopy={onCopy}
                  onOpenUrl={onOpenUrl}
                  streaming={group.id === activeBlockId}
                />
                {fields?.length && onLoadItem && (
                  <AgentItemPreviewButton onLoad={() => onLoadItem(group.id, fields)} />
                )}
              </>
            );
          }

          const isActivity = activityIds.has(group.id);
          return (
            <div
              key={group.id}
              id={`${activityId}-${group.id}`}
              data-chat-anchor={group.id}
              hidden={isActivity && !expanded}
            >
              {content}
            </div>
          );
        })}
        {message.moreItems === "newer" && itemPagination}
        {showGenerationDots && generation.isCompaction && (
          <p role="status" className="text-xs text-muted">
            正在压缩对话上下文
          </p>
        )}
        {showGenerationDots && !generation.isCompaction && (
          <div className="agent-generation-dots" role="status" aria-label="模型正在生成">
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </div>
        )}
      </div>
      {hasFinalResponse && !reply.trim() && <p className="text-xs text-muted">未返回回复内容</p>}
      {message.status === "cancelled" && <p className="text-xs text-muted">已停止</p>}
      {message.error && (
        <p role="alert" className="text-xs text-danger">
          {message.error}
        </p>
      )}
      {message.status !== "generating" && !!(reply.trim() || message.timestampMs) && (
        <div className="agent-message-actions">
          {reply.trim() && <AgentCopyButton text={reply} label="复制回复" onCopy={copyReply} />}
          <AgentMessageTime timestampMs={message.timestampMs} />
        </div>
      )}
    </div>
  );
}
