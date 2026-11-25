import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface QuickChatQueuedInput {
  id: string;
  text: string;
  mode: "follow-up" | "steering" | "interrupting";
}

interface QuickChatQueueProps {
  items: QuickChatQueuedInput[];
  draft: string;
  replying?: boolean;
  onSteer: (id: string) => void;
  onInterrupt: (id: string) => void;
  onEdit: (id: string, text: string) => Promise<boolean>;
  onRemove: (id: string) => void;
  onRecoverEdit: (text: string) => void;
}

export function QuickChatQueue({
  items,
  draft,
  replying,
  onSteer,
  onInterrupt,
  onEdit,
  onRemove,
  onRecoverEdit,
}: QuickChatQueueProps) {
  const [menu, setMenu] = useState<{ id: string; top: number; right: number }>();
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const menuRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const menuItem = items.find((item) => item.id === menu?.id);

  const lostEdit = !!editing && !items.some((item) => item.id === editing.id);
  const focusKey = editing ? `${editing.id}:${lostEdit}` : undefined;
  useEffect(() => {
    if (focusKey) editRef.current?.focus();
  }, [focusKey]);

  useEffect(() => {
    if (!menu) return;
    function dismissOutside(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (menuRef.current?.contains(target) || target.closest("[data-queue-menu-trigger]")) return;
      setMenu(undefined);
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMenu(undefined);
    }
    document.addEventListener("mousedown", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("mousedown", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [menu]);

  async function saveEdit() {
    if (!editing?.text.trim()) return;
    const current = editing;
    if (await onEdit(current.id, current.text.trim())) {
      setEditing((value) => (value === current ? undefined : value));
    }
  }

  if (!items.length && !editing) return null;

  return (
    <>
      <section
        aria-label="待发送消息"
        className="absolute right-4 bottom-9 z-10 w-[60%] rounded-xl border border-line
          bg-surface shadow-lg"
      >
        <div className="max-h-36 overflow-y-auto p-1">
          {items.map((item, index) => (
            <div
              key={item.id}
              className="relative flex min-w-0 items-center gap-0.5 whitespace-nowrap
                rounded-md py-0.5 pr-1 pl-2 hover:bg-hover"
            >
              {editing?.id === item.id ? (
                <input
                  aria-label="编辑排队消息"
                  className="min-w-0 flex-1 rounded bg-surface px-1 text-sm text-ink"
                  ref={editRef}
                  value={editing.text}
                  onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                  onBlur={() => void saveEdit()}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                      void saveEdit();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setEditing(undefined);
                    }
                  }}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm text-ink" title={item.text}>
                  {item.text}
                </span>
              )}
              {index === 0 && !replying && !draft.trim() && item.mode !== "interrupting" ? (
                <button
                  type="button"
                  className="flex w-[76px] shrink-0 cursor-pointer items-center gap-0.5
                    whitespace-nowrap rounded px-1 py-1 text-xs text-muted hover:bg-hover
                    hover:text-ink focus-visible:ring-2 focus-visible:ring-primary/60"
                  onClick={() =>
                    item.mode === "steering" ? onInterrupt(item.id) : onSteer(item.id)
                  }
                >
                  <span aria-hidden="true" className="w-3 text-center">
                    ↵
                  </span>
                  {item.mode === "steering" ? "立即发送" : "插入引导"}
                </button>
              ) : (
                <span aria-hidden="true" className="w-[76px] shrink-0" />
              )}
              <span
                className={`mr-1 w-12 shrink-0 text-right text-xs ${
                  index === 0 ? "text-primary-text" : "text-ink"
                }`}
              >
                {item.mode === "steering"
                  ? "插入引导"
                  : item.mode === "interrupting"
                    ? "正在打断"
                    : "排队处理"}
              </span>
              <button
                type="button"
                aria-label={`删除消息：${item.text}`}
                className="flex size-5 shrink-0 cursor-pointer items-center justify-center
                  rounded text-muted hover:bg-hover hover:text-ink focus-visible:ring-2
                  focus-visible:ring-primary/60"
                onClick={() => onRemove(item.id)}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v6m4-6v6"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                aria-label={`消息选项：${item.text}`}
                data-queue-menu-trigger
                aria-expanded={menu?.id === item.id}
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center
                  rounded-md text-muted hover:bg-hover hover:text-ink focus-visible:ring-2
                  focus-visible:ring-primary/60"
                onClick={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setMenu(
                    menu?.id === item.id
                      ? undefined
                      : { id: item.id, top: bounds.top, right: window.innerWidth - bounds.right },
                  );
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <circle cx="6" cy="12" r="1.35" />
                  <circle cx="12" cy="12" r="1.35" />
                  <circle cx="18" cy="12" r="1.35" />
                </svg>
              </button>
            </div>
          ))}
          {lostEdit && editing && (
            <div className="flex flex-col gap-1 rounded-md px-2 py-1">
              <span role="status" className="text-xs text-muted">
                消息不再排队，编辑未保存
              </span>
              <input
                ref={editRef}
                aria-label="未保存的编辑"
                className="min-w-0 rounded bg-surface px-1 text-sm text-ink"
                value={editing.text}
                onChange={(event) => setEditing({ ...editing, text: event.target.value })}
              />
              <div className="flex gap-3 text-xs">
                <button
                  type="button"
                  className="cursor-pointer text-primary-text disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={!!draft.trim() || !editing.text.trim()}
                  onClick={() => {
                    onRecoverEdit(editing.text);
                    setEditing(undefined);
                  }}
                >
                  放入输入框
                </button>
                <button
                  type="button"
                  className="cursor-pointer text-muted"
                  onClick={() => setEditing(undefined)}
                >
                  放弃编辑
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
      {menu &&
        menuItem &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-50 w-24 -translate-y-full rounded-lg border border-line
              bg-surface py-1 shadow-lg"
            style={{ top: menu.top, right: menu.right }}
          >
            {menuItem.mode === "follow-up" && (
              <button
                type="button"
                className="w-full cursor-pointer px-3 py-1.5 text-left text-xs
                text-ink hover:bg-hover"
                onClick={() => {
                  onSteer(menuItem.id);
                  setMenu(undefined);
                }}
              >
                插入引导
              </button>
            )}
            {menuItem.mode !== "interrupting" && (
              <button
                type="button"
                className="w-full cursor-pointer px-3 py-1.5 text-left text-xs
                text-ink hover:bg-hover"
                onClick={() => {
                  onInterrupt(menuItem.id);
                  setMenu(undefined);
                }}
              >
                立即发送
              </button>
            )}
            <button
              type="button"
              className="w-full cursor-pointer px-3 py-1.5 text-left text-xs
                text-ink hover:bg-hover"
              onClick={() => {
                setEditing({ id: menuItem.id, text: menuItem.text });
                setMenu(undefined);
              }}
            >
              编辑
            </button>
            <button
              type="button"
              className="w-full cursor-pointer px-3 py-1.5 text-left text-xs
                text-ink hover:bg-hover"
              onClick={() => {
                onRemove(menuItem.id);
                setMenu(undefined);
              }}
            >
              删除
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
