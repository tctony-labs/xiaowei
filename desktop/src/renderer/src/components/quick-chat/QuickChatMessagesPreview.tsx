import { AgentRunStatus, AgentToolStatus } from "proto-desktop-ts";
import { useEffect, useState } from "react";
import { chatMessages } from "../agent-chat/agent-events";
import {
  type MessagePreviewOptions,
  messagePreview,
  previewMarkdown,
} from "./message-preview-fixtures";
import { QuickChatPanel } from "./QuickChatPanel";

export interface QuickChatMessagesPreviewProps extends MessagePreviewOptions {
  narrow?: boolean;
  actionsFail?: boolean;
}

export function QuickChatMessagesPreview({
  narrow = false,
  actionsFail = false,
  ...options
}: QuickChatMessagesPreviewProps) {
  const [expanded, setExpanded] = useState(true);
  const [draft, setDraft] = useState("");
  const [offset, setOffset] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [action, setAction] = useState("");
  const [startedAtMs, setStartedAtMs] = useState(Date.now);
  const streaming = options.scenario === "markdown" && options.streamMarkdown;
  const streamingComplete = offset >= previewMarkdown.length;

  useEffect(() => {
    if (!streaming || stopped || streamingComplete) return;
    const timer = setInterval(
      () => setOffset((value) => Math.min(value + 4, previewMarkdown.length)),
      70,
    );
    return () => clearInterval(timer);
  }, [streaming, stopped, streamingComplete]);

  const frame = messagePreview(
    options,
    startedAtMs,
    streaming ? previewMarkdown.slice(0, offset) : previewMarkdown,
  );
  const run = frame.session.runs[0];
  if (stopped) {
    run.status = AgentRunStatus.INTERRUPTED;
    run.completedAtMs = run.startedAtMs + 3200n;
    run.generation = undefined;
    run.finalGenId = undefined;
    for (const item of run.items) {
      if (
        item.content.case === "toolCall" &&
        item.content.value.status === AgentToolStatus.PENDING
      ) {
        item.content.value.status = AgentToolStatus.CANCELLED;
        item.content.value.output = "用户已停止执行";
      }
    }
  }

  return (
    <div className="mx-auto w-full" style={{ maxWidth: narrow ? 360 : 800 }}>
      <QuickChatPanel
        expanded={expanded}
        search={
          <button type="button" onClick={() => setExpanded(true)}>
            返回对话预览
          </button>
        }
        messages={empty ? [] : chatMessages(frame.session)}
        onCopyMessageText={async (text) => {
          if (actionsFail) throw new Error("preview copy failure");
          setAction(`已复制 ${text.length} 个字符（预览）`);
        }}
        onOpenMessageUrl={async (url) => {
          if (actionsFail) throw new Error("preview link failure");
          setAction(`打开链接（预览）：${url}`);
        }}
        sessionId={frame.session.sessionId}
        title={empty ? "新的对话" : frame.session.title}
        draft={draft}
        configured
        generating={!empty && run.status === AgentRunStatus.IN_PROGRESS}
        onDraftChange={setDraft}
        onSend={() => setAction("预览不发送消息")}
        onStop={() => setStopped(true)}
        onNewConversation={() => {
          setStopped(true);
          setEmpty(true);
          setDraft("");
        }}
        onCollapse={() => setExpanded(false)}
      />
      <div className="flex items-center gap-3 px-4 py-2 text-xs text-muted">
        <button
          type="button"
          onClick={() => {
            setStartedAtMs(Date.now());
            setOffset(0);
            setStopped(false);
            setEmpty(false);
            setAction("");
          }}
        >
          重新演示
        </button>
        <p role="status">{action}</p>
      </div>
    </div>
  );
}
