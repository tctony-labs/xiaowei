import { useState } from "react";
import { type QuickChatMessage, QuickChatPanel } from "./QuickChatPanel";
import type { QuickChatQueuedInput } from "./QuickChatQueue";

const initialQueue: QuickChatQueuedInput[] = [
  { id: "1", text: "再帮我列出需要优先处理的事项。", mode: "follow-up" },
  { id: "2", text: "最后整理成一份简短的行动清单。", mode: "follow-up" },
];

const initialMessages: QuickChatMessage[] = [
  { id: "user", role: "user", text: "帮我梳理一下今天的工作安排。" },
  {
    id: "assistant",
    role: "assistant",
    blocks: [{ id: "answer", kind: "text", text: "我先看看目前的任务，再整理今天的安排。" }],
    status: "generating",
  },
];

// Storybook fixture only; the displayed queue is not connected to the Agent.
export function QuickChatQueuePreview() {
  const [draft, setDraft] = useState("");
  const [queue, setQueue] = useState(initialQueue);
  const [messages, setMessages] = useState(initialMessages);
  const [nextId, setNextId] = useState(3);
  const [notice, setNotice] = useState("");

  function submit() {
    if (!draft.trim()) return;
    setQueue((items) => [...items, { id: String(nextId), text: draft.trim(), mode: "follow-up" }]);
    setNextId((id) => id + 1);
    setDraft("");
    setNotice("");
  }

  function steer(id: string) {
    setQueue((items) =>
      items.map((item) => (item.id === id ? { ...item, mode: "steering" } : item)),
    );
    setNotice("");
  }

  function consume(item: QuickChatQueuedInput, message: string) {
    setQueue((items) => items.filter((entry) => entry.id !== item.id));
    setMessages((items) => [
      ...items.map((entry) =>
        entry.status === "generating" ? { ...entry, status: "complete" as const } : entry,
      ),
      { id: `user-${item.id}`, role: "user", text: item.text },
      {
        id: `assistant-${item.id}`,
        role: "assistant",
        blocks: [{ id: `answer-${item.id}`, kind: "text", text: message }],
        status: "generating",
      },
    ]);
  }

  function interrupt(id: string) {
    const item = queue.find((entry) => entry.id === id);
    if (!item) return;
    consume(item, "已开始新一轮对话，正在处理这条消息。");
    setNotice("已打断当前对话，开始新一轮");
  }

  function reachBoundary() {
    const item = queue.find((entry) => entry.mode === "steering");
    if (!item) return;
    consume(item, "已在当前对话中接收补充指令，继续处理。");
    setNotice("已在工具调用间隙插入");
  }

  function finishRun() {
    const first = queue[0];
    if (!first) return;
    consume(first, "上一轮已结束，正在处理排队消息。");
    setNotice("已开始下一轮对话");
  }

  return (
    <div className="mx-auto w-full max-w-[800px]">
      <QuickChatPanel
        expanded
        search={null}
        messages={messages}
        sessionId="queue-preview"
        title="今天的工作安排"
        onCopyMessageText={async () => {}}
        onOpenMessageUrl={async () => {}}
        draft={draft}
        configured
        generating
        modelOptions={[{ value: "model", label: "GPT-6" }]}
        selectedModelRef="model"
        reasoning="high"
        supportedReasoning={["high"]}
        onModelChange={() => {}}
        onReasoningChange={() => {}}
        onDraftChange={setDraft}
        onSend={submit}
        onStop={() => setNotice("当前对话已停止（预览）")}
        onNewConversation={() => {}}
        onCollapse={() => {}}
        queuedInputs={queue}
        onSteerQueuedInput={steer}
        onInterruptQueuedInput={interrupt}
        onEditQueuedInput={async (id, text) => {
          setQueue((items) => items.map((item) => (item.id === id ? { ...item, text } : item)));
          return true;
        }}
        onRemoveQueuedInput={(id) => setQueue((items) => items.filter((item) => item.id !== id))}
      />
      <div className="flex flex-wrap items-center gap-4 px-4 py-3 text-xs text-muted">
        <span>模拟：</span>
        <button type="button" className="cursor-pointer text-primary-text" onClick={reachBoundary}>
          到达工具间隙
        </button>
        <button type="button" className="cursor-pointer text-primary-text" onClick={finishRun}>
          当前 Run 结束
        </button>
        <button
          type="button"
          className="cursor-pointer text-primary-text"
          onClick={() => {
            setQueue(initialQueue);
            setMessages(initialMessages);
            setDraft("");
            setNextId(3);
            setNotice("");
          }}
        >
          重新演示
        </button>
        <span role="status">{notice}</span>
      </div>
    </div>
  );
}
