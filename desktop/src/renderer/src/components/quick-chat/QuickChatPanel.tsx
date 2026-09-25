import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { hasOpenModal } from "../modal-state";
import QuickChatTitleBar from "./QuickChatTitleBar";
import { QuickChatTransition } from "./QuickChatTransition";

export interface QuickChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  status?: "generating" | "complete" | "cancelled" | "failed";
  error?: string;
}

export interface QuickChatPanelProps {
  expanded: boolean;
  search: ReactNode;
  searchHeight?: number;
  messages: QuickChatMessage[];
  draft: string;
  configured: boolean;
  generating: boolean;
  loading?: boolean;
  error?: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onNewConversation: () => void;
  onCollapse: () => void;
}

// No sessions, persistence or Gateway connection here: the page adapter owns the conversation.
export function QuickChatPanel(props: QuickChatPanelProps) {
  const composer = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const scroll = useRef<HTMLElement>(null);
  const followOutput = useRef(true);
  const scrollPosition = useRef(0);
  const [composerHeight, setComposerHeight] = useState(65);
  const canSend = props.configured && !!props.draft.trim() && !props.generating && !props.loading;
  const title = props.messages.find((message) => message.role === "user")?.text ?? "新的对话";

  useLayoutEffect(() => {
    if (props.expanded) composer.current?.focus();
  }, [props.expanded]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Measure the controlled draft after each edit.
  useLayoutEffect(() => {
    const input = composer.current;
    if (!input || !props.expanded) return;
    input.style.height = "21px";
    const height = Math.min(105, Math.max(21, input.scrollHeight));
    input.style.height = `${height}px`;
    setComposerHeight(Math.max(65, height + 25));
  }, [props.draft, props.expanded]);

  useLayoutEffect(() => {
    if (!props.messages.length) followOutput.current = true;
    if (scroll.current && props.expanded) {
      scroll.current.scrollTop = followOutput.current ? scroll.current.scrollHeight : scrollPosition.current;
    }
  }, [props.messages, props.expanded]);

  function send() {
    if (!canSend) return;
    followOutput.current = true;
    props.onSend();
    composer.current?.focus();
  }

  function newConversation() {
    followOutput.current = true;
    props.onNewConversation();
    composer.current?.focus();
  }

  const input = (
    <div className="relative shrink-0 border-t border-subtle" style={{ height: composerHeight }}>
      <div className="flex h-full min-h-16 items-center gap-2 px-6 py-3">
        <textarea
          ref={composer}
          aria-label="快速对话输入"
          placeholder="输入消息，Enter 发送"
          rows={1}
          value={props.draft}
          className="min-w-0 flex-1 resize-none bg-transparent text-sm leading-[21px] text-ink placeholder:text-muted"
          onChange={(event) => props.onDraftChange(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          aria-label={props.generating ? "停止生成" : "发送消息"}
          disabled={!props.generating && !canSend}
          onClick={props.generating ? props.onStop : send}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-primary
            text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {props.generating ? (
            <span className="size-3 rounded-sm bg-current" />
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <path d="m5 12 7-7 7 7M12 5v14" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <section
      aria-label="快速对话"
      className="w-full"
      onKeyDown={(event) => {
        if (!props.expanded || event.defaultPrevented || hasOpenModal()) return;
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        const inComposer = event.target === composer.current;
        if (event.key === "Escape" || (event.key === "ArrowUp" && inComposer && !props.draft.trim())) {
          event.preventDefault();
          props.onCollapse();
        } else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === "n") {
          event.preventDefault();
          newConversation();
        }
      }}
    >
      <QuickChatTransition
        expanded={props.expanded}
        searchHeight={props.searchHeight}
        composerHeight={composerHeight}
        search={props.search}
        composer={input}
      >
        {(animating) => (
          <div className="flex h-full min-h-0 flex-col">
            <QuickChatTitleBar
              minimal
              title={title}
              isGenerating={props.generating}
              onCreateSession={newConversation}
            />
            <section
              ref={scroll}
              aria-label="对话消息"
              onScroll={() => {
                const element = scroll.current;
                if (element && props.expanded) {
                  scrollPosition.current = element.scrollTop;
                  followOutput.current = element.scrollHeight - element.clientHeight - element.scrollTop < 40;
                }
              }}
              className={`min-h-0 flex-1 px-4 ${animating ? "overflow-hidden" : "overflow-y-auto"}`}
            >
              <div className="flex flex-col gap-3 py-3">
                {!props.messages.length && !props.error && (
                  <p className="py-6 text-center text-sm text-muted">
                    {props.loading ? "正在加载模型" : "输入问题开始对话"}
                  </p>
                )}
                {props.messages.map((message) => (
                  <article
                    key={message.id}
                    aria-label={message.role === "user" ? "用户消息" : "助手消息"}
                    className={
                      message.role === "user"
                        ? "ml-auto max-w-[85%] rounded-xl bg-hover px-3 py-2 text-sm text-ink"
                        : "text-sm leading-6 text-ink"
                    }
                  >
                    {message.thinking && (
                      <details className="mb-2 border-l-2 border-line pl-3 text-xs text-muted">
                        <summary className="cursor-pointer py-1">
                          {message.status === "generating" && !message.text ? "正在思考" : "思考过程"}
                        </summary>
                        <p className="whitespace-pre-wrap break-words">{message.thinking}</p>
                      </details>
                    )}
                    {message.text && <p className="whitespace-pre-wrap break-words">{message.text}</p>}
                    {message.status === "generating" && !message.text && !message.thinking && (
                      <p role="status" className="text-xs text-muted">
                        正在等待回复…
                      </p>
                    )}
                    {message.status === "cancelled" && <p className="mt-1 text-xs text-muted">已停止</p>}
                    {message.error && (
                      <p role="alert" className="mt-1 text-xs text-danger">
                        {message.error}
                      </p>
                    )}
                  </article>
                ))}
                {props.error && (
                  <p role="alert" className="text-xs text-danger">
                    {props.error}
                  </p>
                )}
              </div>
            </section>
          </div>
        )}
      </QuickChatTransition>
    </section>
  );
}
