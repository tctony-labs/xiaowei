import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import logo from "../../../../../resources/logo-clear.png";
import { LauncherSearchBar } from "../LauncherSearchBar";
import { hasOpenModal } from "../modal-state";
import QuickChatTitleBar from "./QuickChatTitleBar";
import { QuickChatTransition } from "./QuickChatTransition";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface Session {
  id: string;
  title: string;
  autoTitle: boolean;
  archived: boolean;
  messages: Message[];
}

export interface QuickChatLauncherPreviewProps {
  initialState?: "first-use" | "existing" | "last-session" | "all-archived" | "all-deleted";
  initiallyExpanded?: boolean;
  initialQuery?: string;
}

function initialSessions(state: QuickChatLauncherPreviewProps["initialState"]): Session[] {
  if (state === "first-use" || state === "all-deleted") return [];
  const items: Session[] = [
    {
      id: "mock-1",
      title: "整理本周的开发事项",
      autoTitle: true,
      archived: state === "all-archived",
      messages: [
        { id: "user-1", role: "user", text: "帮我整理一下本周要做的事情。" },
        {
          id: "assistant-1",
          role: "assistant",
          text: "可以先核对已有事项，再按优先级安排。这周有哪些需要完成的任务？",
        },
      ],
    },
  ];
  if (state === "existing") {
    items.push({
      id: "mock-2",
      title: "搜索与剪贴板交互讨论",
      autoTitle: false,
      archived: false,
      messages: [{ id: "user-2", role: "user", text: "看看搜索与剪贴板的键盘交互。" }],
    });
  }
  return items;
}

// Only Storybook and component tests import this adapter. All sessions and replies live in memory.
export function QuickChatLauncherPreview({
  initialState = "existing",
  initiallyExpanded = false,
  initialQuery = "",
}: QuickChatLauncherPreviewProps) {
  const [sessions, setSessions] = useState(() => initialSessions(initialState));
  const [activeId, setActiveId] = useState<string | null>(
    () => initialSessions(initialState).find((session) => !session.archived)?.id ?? null,
  );
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [query, setQuery] = useState(initialQuery);
  const [selectedResult, setSelectedResult] = useState(0);
  const [draft, setDraft] = useState("");
  const [composerHeight, setComposerHeight] = useState(65);
  const [model, setModel] = useState("默认模型");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [notice, setNotice] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const modelControls = useRef<HTMLFieldSetElement>(null);
  const nextId = useRef(3);
  const active = sessions.find((session) => session.id === activeId && !session.archived);
  const available = sessions.filter((session) => !session.archived);
  const generating = runningId !== null && runningId === activeId;
  const results = query.trim() ? ["应用搜索示例", "剪贴板搜索示例"] : [];

  useEffect(() => {
    if (!runningId) return;
    const timer = setTimeout(() => {
      setSessions((items) =>
        items.map((session) =>
          session.id === runningId
            ? {
                ...session,
                messages: [
                  ...session.messages,
                  { id: crypto.randomUUID(), role: "assistant", text: "收到，我们可以继续讨论这件事。" },
                ],
              }
            : session,
        ),
      );
      setRunningId(null);
    }, 1200);
    return () => clearTimeout(timer);
  }, [runningId]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeOutside = (event: MouseEvent) => {
      if (!modelControls.current?.contains(event.target as Node)) setModelMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [modelMenuOpen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Restore composer focus after a session switch.
  useLayoutEffect(() => {
    if (!expanded) return;
    composer.current?.focus();
  }, [expanded, activeId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Measure after React commits the controlled draft.
  useLayoutEffect(() => {
    const input = composer.current;
    if (!input || !expanded) return;
    input.style.height = "21px";
    const height = Math.min(105, Math.max(21, input.scrollHeight));
    input.style.height = `${height}px`;
    setComposerHeight(Math.max(65, height + 25));
  }, [draft, expanded]);

  function createSession() {
    composer.current?.focus();
    setModel("默认模型");
    if (active && active.messages.length === 0) return;
    const id = `mock-${nextId.current++}`;
    setSessions((items) => [{ id, title: "新的对话", autoTitle: true, archived: false, messages: [] }, ...items]);
    setActiveId(id);
    setDraft("");
  }

  function removeSession(archive: boolean) {
    const remaining = available.filter((session) => session.id !== activeId);
    setSessions((items) =>
      archive
        ? items.map((session) => (session.id === activeId ? { ...session, archived: true } : session))
        : items.filter((session) => session.id !== activeId),
    );
    if (runningId === activeId) setRunningId(null);
    setActiveId(remaining[0]?.id ?? null);
    setDraft("");
  }

  function send() {
    if (!draft.trim() || generating) return;
    const id = activeId ?? `mock-${nextId.current++}`;
    const message: Message = { id: crypto.randomUUID(), role: "user", text: draft };
    const session: Session = active ?? {
      id,
      title: "新的对话",
      autoTitle: true,
      archived: false,
      messages: [],
    };
    const updated = { ...session, messages: [...session.messages, message] };
    setSessions((items) => [updated, ...items.filter((item) => item.id !== id)]);
    setActiveId(id);
    setRunningId(id);
    setDraft("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current || hasOpenModal()) return;
    if (root.current?.querySelector('[data-quick-chat-keyboard-layer="true"]')) return;
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const inComposer = target === composer.current;
    const inSearch = target.getAttribute("aria-label") === "搜索";

    if (event.key === "ArrowDown" && !expanded && (inSearch || inComposer) && !query.trim()) {
      event.preventDefault();
      setActiveId(available[0]?.id ?? null);
      setDraft("");
      setExpanded(true);
    } else if (expanded && (event.key === "Escape" || (event.key === "ArrowUp" && inComposer && !draft.trim()))) {
      event.preventDefault();
      setModelMenuOpen(false);
      setExpanded(false);
      setQuery("");
    } else if (
      expanded &&
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === "n"
    ) {
      event.preventDefault();
      createSession();
    }
  }

  const search = (
    <LauncherSearchBar
      embedded
      query={query}
      onQueryChange={(value) => {
        setQuery(value);
        setSelectedResult(0);
      }}
      placeholder="输入搜索内容 或 按 ↓ 进入快速对话"
      onCompositionChange={(value) => {
        composing.current = value;
      }}
      onDismiss={() => setHidden(true)}
      onNavigate={(event) => {
        if (event.key === "ArrowDown" && !query.trim()) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedResult((index) =>
            Math.max(0, Math.min(results.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))),
          );
        }
      }}
    >
      {results.map((result, index) => (
        <div key={result} className={`px-6 py-3 text-sm ${selectedResult === index ? "bg-primary-bg" : ""}`}>
          {result}
        </div>
      ))}
    </LauncherSearchBar>
  );

  const input = (
    <div className="relative shrink-0 border-t border-subtle" style={{ height: composerHeight }}>
      <fieldset
        ref={modelControls}
        aria-label="模型选择"
        className="absolute bottom-full right-3 mb-1 rounded-md bg-surface text-xs text-muted"
        onKeyDown={(event) => {
          if (modelMenuOpen && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setModelMenuOpen(false);
            composer.current?.focus();
          }
        }}
      >
        <button type="button" className="cursor-pointer px-2 py-1" onClick={() => setModelMenuOpen(!modelMenuOpen)}>
          {model}
        </button>
        {modelMenuOpen && (
          <div
            data-quick-chat-keyboard-layer="true"
            className="absolute bottom-full right-0 mb-1 w-36 rounded-lg border border-line bg-elevated p-1 shadow-lg"
          >
            {["默认模型", "推理模型"].map((name) => (
              <button
                key={name}
                type="button"
                className="block w-full cursor-pointer rounded p-2 text-left hover:bg-hover"
                onClick={() => {
                  setModel(name);
                  setModelMenuOpen(false);
                  composer.current?.focus();
                }}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </fieldset>
      <div className="flex h-full min-h-16 items-center gap-2 px-6 py-3">
        <textarea
          ref={composer}
          aria-label="快速对话输入"
          placeholder="输入指令, /, @"
          rows={1}
          value={draft}
          className="min-w-0 flex-1 resize-none bg-transparent text-sm leading-[21px] text-ink placeholder:text-muted"
          onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (modelMenuOpen && event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setModelMenuOpen(false);
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (expanded) send();
            }
          }}
        />
        <div className="relative size-8 shrink-0">
          <img src={logo} alt="XiaoWei" className="size-8 rounded-md" draggable={false} />
          {generating && (
            <button
              type="button"
              aria-label="停止生成"
              onClick={() => setRunningId(null)}
              className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-md bg-surface"
            >
              <span className="size-3 rounded-sm bg-ink" />
            </button>
          )}
        </div>
      </div>
    </div>
  );

  if (hidden)
    return (
      <button
        type="button"
        className="m-4 cursor-pointer rounded-lg bg-elevated px-4 py-2 text-sm text-ink"
        onClick={() => setHidden(false)}
      >
        重新打开搜索框
      </button>
    );

  return (
    <section ref={root} aria-label="快捷窗口预览" className="w-[800px]" onKeyDown={handleKeyDown}>
      <QuickChatTransition
        expanded={expanded}
        searchHeight={71 + results.length * 44}
        composerHeight={composerHeight}
        search={search}
        composer={input}
      >
        {(animating) => (
          <div className="flex h-full min-h-0 flex-col">
            <QuickChatTitleBar
              key={activeId ?? "draft"}
              convId={activeId}
              title={active?.title ?? "新的对话"}
              autoTitle={active?.autoTitle ?? true}
              workspaceDir={activeId ? `/Users/demo/.xiaowei/quick-chat/${activeId}` : null}
              grantedPaths={[]}
              isGenerating={generating}
              isRegeneratingTitle={false}
              hasAssistantReply={active?.messages.some((message) => message.role === "assistant") ?? false}
              sessions={available}
              sessionsLoading={false}
              onListSessions={() => {}}
              onCreateSession={createSession}
              onSwitchSession={(id) => {
                setActiveId(id);
                setDraft("");
              }}
              onRename={(title) =>
                setSessions((items) =>
                  items.map((session) => (session.id === activeId ? { ...session, title, autoTitle: false } : session)),
                )
              }
              onRegenerateTitle={async () =>
                setSessions((items) =>
                  items.map((session) =>
                    session.id === activeId ? { ...session, title: "本周事项讨论", autoTitle: true } : session,
                  ),
                )
              }
              onArchive={() => removeSession(true)}
              onDelete={() => removeSession(false)}
              onCopyId={async () => {}}
              onOpenTitleModelSettings={() => setNotice("已模拟打开模型设置")}
            />
            <div className={`min-h-0 flex-1 px-4 pb-9 ${animating ? "overflow-hidden" : "overflow-y-auto"}`}>
              {!active?.messages.length ? (
                <p className="py-6 text-center text-sm text-muted">输入问题开始对话</p>
              ) : (
                <div className="flex flex-col gap-3 py-2">
                  {active.messages.map((message) => (
                    <div
                      key={message.id}
                      className={
                        message.role === "user"
                          ? "ml-auto max-w-[85%] rounded-xl bg-hover px-3 py-2 text-sm text-ink"
                          : "text-sm leading-6 text-ink"
                      }
                    >
                      {message.text}
                    </div>
                  ))}
                </div>
              )}
              {generating && (
                <p role="status" className="py-2 text-xs text-muted">
                  正在思考...
                </p>
              )}
              {notice && (
                <p role="status" className="py-2 text-xs text-muted">
                  {notice}
                </p>
              )}
            </div>
          </div>
        )}
      </QuickChatTransition>
    </section>
  );
}
