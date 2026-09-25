import { useEffect, useState } from "react";
import { LauncherSearchBar } from "../LauncherSearchBar";
import { type QuickChatMessage, QuickChatPanel } from "./QuickChatPanel";

export interface QuickChatChatPreviewProps {
  scenario?: "empty" | "missing-default" | "loading" | "text" | "thinking" | "complete" | "error" | "stopped";
  initiallyExpanded?: boolean;
}

function initialMessages(scenario: QuickChatChatPreviewProps["scenario"]): QuickChatMessage[] {
  if (scenario === "empty" || scenario === "missing-default" || scenario === "loading") return [];
  return [
    { id: "user", role: "user", text: "帮我把今天的工作安排成三个步骤。" },
    {
      id: "assistant",
      role: "assistant",
      text:
        scenario === "thinking" || scenario === "error"
          ? ""
          : scenario === "text" || scenario === "stopped"
            ? "可以先明确今天最需要完成的一件事。"
            : "1. 先明确今天最需要完成的一件事。\n2. 集中时间完成它，并验证结果。\n3. 整理剩余事项，安排下一步。",
      thinking: scenario === "thinking" ? "先确定优先级，再把执行和验证分开，最后留出整理时间。" : undefined,
      status:
        scenario === "text" || scenario === "thinking"
          ? "generating"
          : scenario === "error"
            ? "failed"
            : scenario === "stopped"
              ? "cancelled"
              : "complete",
      error: scenario === "error" ? "模型请求失败，请稍后重试。" : undefined,
    },
  ];
}

// Storybook-only adapter. Replies are simulated; no Gateway, user configuration or network access.
export function QuickChatChatPreview({ scenario = "empty", initiallyExpanded = true }: QuickChatChatPreviewProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState(() => initialMessages(scenario));
  const [run, setRun] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const generating = messages.some((message) => message.status === "generating");
  const configured = scenario !== "missing-default";

  useEffect(() => {
    if (!run) return;
    const thinking = "先理解问题，再把回答整理成清晰的步骤。";
    const answer = "这是模拟的流式回复。\n你可以继续追问、停止生成，或新建一段对话。";
    let offset = 0;
    const timer = setInterval(() => {
      offset += 2;
      const complete = offset >= thinking.length + answer.length;
      setMessages((items) =>
        items.map((message) =>
          message.id === run
            ? {
                ...message,
                thinking: thinking.slice(0, offset),
                text: answer.slice(0, Math.max(0, offset - thinking.length)),
                status: complete ? "complete" : "generating",
              }
            : message,
        ),
      );
      if (complete) setRun(null);
    }, 80);
    return () => clearInterval(timer);
  }, [run]);

  function send() {
    if (!configured || !draft.trim() || generating) return;
    const id = crypto.randomUUID();
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", text: draft },
      { id, role: "assistant", text: "", status: "generating" },
    ]);
    setDraft("");
    setRun(id);
  }

  function stop() {
    setRun(null);
    setMessages((items) =>
      items.map((message) => (message.status === "generating" ? { ...message, status: "cancelled" } : message)),
    );
  }

  if (hidden) {
    return (
      <button type="button" className="m-4 rounded-lg bg-elevated px-4 py-2 text-ink" onClick={() => setHidden(false)}>
        重新打开搜索框
      </button>
    );
  }

  return (
    <div className="w-full max-w-[800px]">
      <QuickChatPanel
        expanded={expanded}
        search={
          <LauncherSearchBar
            embedded
            query={query}
            onQueryChange={setQuery}
            onDismiss={() => setHidden(true)}
            placeholder="输入搜索内容 或 按 ↓ 进入快速对话"
            onNavigate={(event) => {
              if (event.key === "ArrowDown" && !query.trim()) {
                event.preventDefault();
                setExpanded(true);
              }
            }}
          />
        }
        messages={messages}
        draft={draft}
        configured={configured}
        generating={generating}
        loading={scenario === "loading"}
        error={!configured ? "未设置默认模型，请先在设置 → 模型中配置。" : undefined}
        onDraftChange={setDraft}
        onSend={send}
        onStop={stop}
        onNewConversation={() => {
          setRun(null);
          setMessages([]);
          setDraft("");
        }}
        onCollapse={() => setExpanded(false)}
      />
    </div>
  );
}
