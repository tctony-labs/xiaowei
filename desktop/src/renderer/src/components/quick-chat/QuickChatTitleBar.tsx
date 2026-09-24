import { useCallback, useEffect, useRef, useState } from "react";
import Modal, { ModalButton } from "../Modal";

export interface QuickChatSessionItem {
  id: string;
  title: string;
}

export interface QuickChatTitleBarProps {
  convId: string | null;
  title: string;
  autoTitle: boolean;
  workspaceDir: string | null;
  grantedPaths: { path: string; is_directory: boolean }[];
  isGenerating: boolean;
  isRegeneratingTitle: boolean;
  hasAssistantReply: boolean;
  sessions: QuickChatSessionItem[];
  sessionsLoading: boolean;
  onListSessions: () => void;
  onCreateSession: () => void;
  onSwitchSession: (id: string) => void;
  onRename: (title: string) => void;
  onRegenerateTitle: () => Promise<void>;
  onArchive: () => void;
  onDelete: () => void;
  onCopyId: (id: string) => Promise<void>;
  onOpenTitleModelSettings: () => void;
}

/** 将绝对路径中的 home 目录前缀替换为 ~ */
function shortenHome(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

const iconButtonClass =
  "flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-neutral-500 " +
  "hover:bg-neutral-200 hover:text-neutral-700 qc-dark:text-neutral-400 " +
  "qc-dark:hover:bg-neutral-700 qc-dark:hover:text-neutral-100";

export default function QuickChatTitleBar({
  convId,
  title,
  autoTitle,
  workspaceDir,
  grantedPaths,
  isGenerating,
  isRegeneratingTitle,
  hasAssistantReply,
  sessions,
  sessionsLoading,
  onListSessions,
  onCreateSession: createNewSession,
  onSwitchSession: switchSession,
  onRename: renameConversation,
  onRegenerateTitle: regenerateTitle,
  onArchive: archiveConversation,
  onDelete: deleteConversation,
  onCopyId,
  onOpenTitleModelSettings,
}: QuickChatTitleBarProps) {
  const normalizedWorkspace = (workspaceDir ?? "").replace(/\/+$/, "").replace(/\/\.\//g, "/");
  const isQuickChat = /\/quick-chat(\/|$)/.test(normalizedWorkspace);
  const isHomeCwd = /^\/(?:Users|home)\/[^/]+$/.test(workspaceDir ?? "");
  const defaultWritable = (() => {
    const cwdShort = isQuickChat
      ? (normalizedWorkspace.match(/(?:^|\/)(quick-chat(?:\/.*)?)$/)?.[1] ?? normalizedWorkspace)
      : shortenHome(workspaceDir ?? "");
    const builtins = ["~/tmp", "/tmp"];
    const paths = isHomeCwd || !workspaceDir ? builtins : [cwdShort, ...builtins.filter((p) => p !== cwdShort)];
    return paths.join(", ");
  })();

  const [menuOpen, setMenuOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(title);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [copyToast, setCopyToast] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(copyTimer.current);
      clearTimeout(errorTimer.current);
    },
    [],
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sessionsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sessionsTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (triggerRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!sessionsOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (sessionsRef.current?.contains(e.target as Node)) return;
      if (sessionsTriggerRef.current?.contains(e.target as Node)) return;
      setSessionsOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSessionsOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sessionsOpen]);

  const openSessionsMenu = useCallback(() => {
    setMenuOpen(false);
    setSessionsOpen(!sessionsOpen);
    if (!sessionsOpen) onListSessions();
  }, [onListSessions, sessionsOpen]);

  const handleNewSession = useCallback(() => {
    setSessionsOpen(false);
    setMenuOpen(false);
    void createNewSession();
  }, [createNewSession]);

  const handleSelectSession = useCallback(
    (id: string) => {
      setSessionsOpen(false);
      void switchSession(id);
    },
    [switchSession],
  );

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) setEditTitle(title);
  }, [title, editing]);

  const startRename = useCallback(() => {
    if (!convId) return;
    setEditTitle(title);
    setEditing(true);
    setMenuOpen(false);
  }, [convId, title]);

  const submitRename = useCallback(() => {
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== title && convId) {
      void renameConversation(trimmed);
    }
    setEditing(false);
  }, [editTitle, title, convId, renameConversation]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") {
        e.preventDefault();
        submitRename();
      } else if (e.key === "Escape") {
        setEditing(false);
      }
    },
    [submitRename],
  );

  const handleArchive = useCallback(() => {
    if (!convId) return;
    void archiveConversation();
    setMenuOpen(false);
  }, [convId, archiveConversation]);

  const handleDeleteConfirm = useCallback(() => {
    if (!convId) return;
    void deleteConversation();
    setDeleteOpen(false);
  }, [convId, deleteConversation]);

  const handleCopyId = useCallback(async () => {
    if (!convId) return;
    try {
      await onCopyId(convId);
      setCopyToast(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyToast(false), 1500);
    } catch (err) {
      console.warn("clipboard write failed", err);
    }
    setMenuOpen(false);
  }, [convId, onCopyId]);

  const regenerateDisabled = !convId || isGenerating || isRegeneratingTitle || !hasAssistantReply;

  const handleRegenerateTitle = useCallback(async () => {
    if (regenerateDisabled) return;
    setMenuOpen(false);
    setRegenError(null);
    try {
      await regenerateTitle();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRegenError(msg || "标题生成失败");
      clearTimeout(errorTimer.current);
      errorTimer.current = setTimeout(() => setRegenError(null), 8000);
    }
  }, [regenerateDisabled, regenerateTitle]);

  return (
    <>
      <div
        data-drag-window
        data-quick-chat-keyboard-layer={menuOpen || sessionsOpen || editing || undefined}
        className={
          "quick-chat-title-bar relative z-20 flex h-10 shrink-0 items-center gap-2 " + "border-b border-subtle px-4"
        }
      >
        <div className="relative min-w-0 flex-1">
          {editing ? (
            <input
              aria-label="对话标题"
              ref={inputRef}
              data-no-drag
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={handleEditKeyDown}
              onBlur={submitRename}
              className={
                "w-full max-w-md rounded-md border border-neutral-300 bg-white px-2 py-1 " +
                "text-sm text-neutral-700 outline-none focus:border-primary " +
                "qc-dark:border-neutral-600 qc-dark:bg-neutral-800 qc-dark:text-neutral-200"
              }
            />
          ) : (
            <div className="group/title w-fit max-w-full">
              <span
                data-no-drag
                className={`block select-text truncate text-sm font-medium ${
                  isGenerating || isRegeneratingTitle
                    ? "quick-chat-title-shimmer"
                    : "text-neutral-700 qc-dark:text-neutral-200"
                }`}
              >
                {title}
              </span>
              <div
                data-no-drag
                className={
                  "pointer-events-none absolute -left-4 top-full z-50 min-w-72 rounded-b-lg " +
                  "border border-t-0 border-subtle bg-elevated px-4 py-2 text-xs opacity-0 " +
                  "shadow-md transition-opacity duration-150 " +
                  "group-hover/title:pointer-events-auto group-hover/title:opacity-100"
                }
              >
                <div className="flex flex-col gap-1 text-ink-secondary">
                  {!isQuickChat && workspaceDir && (
                    <span className="select-text text-ink">工作区：{shortenHome(workspaceDir)}</span>
                  )}
                  <span className="select-text text-ink">{autoTitle ? "自动" : "不自动"}生成标题</span>
                  <div className="border-t border-subtle pt-1">
                    <span className="select-text text-ink">默认可写：{defaultWritable}</span>
                    {grantedPaths.length > 0 && (
                      <div className="mt-0.5">
                        <span className="select-text text-ink">
                          额外授权：
                          {grantedPaths.map((gp) => shortenHome(gp.path) + (gp.is_directory ? "/" : "")).join(", ")}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="relative flex shrink-0 items-center gap-0.5">
          <div className="group/new relative shrink-0">
            <button
              type="button"
              data-no-drag
              onClick={handleNewSession}
              aria-label="新建对话"
              className={iconButtonClass}
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d={
                    "M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5" +
                    " 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4" +
                    ".487z"
                  }
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19 13.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5.5"
                />
              </svg>
            </button>
            <span
              className={
                "pointer-events-none absolute right-0 top-full z-50 mt-1 flex items-center " +
                "gap-1.5 whitespace-nowrap rounded-md border border-subtle bg-elevated px-2 " +
                "py-1 text-xs text-ink opacity-0 shadow-md transition-opacity duration-150 " +
                "group-hover/new:opacity-100"
              }
            >
              新建对话
              <span className="text-muted text-[10px]">⌘N</span>
            </span>
          </div>

          {menuOpen && (
            <div
              ref={menuRef}
              className={
                "absolute right-0 top-9 z-50 min-w-44 rounded-lg border border-neutral-200 " +
                "bg-white py-1 shadow-lg qc-dark:border-neutral-600 qc-dark:bg-neutral-800"
              }
            >
              <button
                type="button"
                onClick={() => void handleCopyId()}
                disabled={!convId}
                className={
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm " +
                  "text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed " +
                  "disabled:opacity-50 disabled:hover:bg-transparent qc-dark:text-neutral-200 " +
                  "qc-dark:hover:bg-neutral-700 qc-dark:disabled:hover:bg-transparent " +
                  "enabled:cursor-pointer"
                }
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d={
                      "M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h6a2" +
                      " 2 0 002-2M8 5a2 2 0 012-2h6a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l" +
                      "3-3m-3 3l3 3"
                    }
                  />
                </svg>
                Session ID
              </button>
              <div className="my-1 h-px bg-neutral-200 qc-dark:bg-neutral-700" />
              <button
                type="button"
                onClick={startRename}
                disabled={!convId}
                className={
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm " +
                  "text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed " +
                  "disabled:opacity-50 disabled:hover:bg-transparent qc-dark:text-neutral-200 " +
                  "qc-dark:hover:bg-neutral-700 qc-dark:disabled:hover:bg-transparent " +
                  "enabled:cursor-pointer"
                }
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d={
                      "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0" +
                      " 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    }
                  />
                </svg>
                重命名
              </button>
              <button
                type="button"
                onClick={() => void handleRegenerateTitle()}
                disabled={regenerateDisabled}
                title={
                  !hasAssistantReply
                    ? "需要至少一轮对话后才能生成标题"
                    : isGenerating
                      ? "正在回复中，请稍候"
                      : isRegeneratingTitle
                        ? "正在生成标题..."
                        : undefined
                }
                className={
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm " +
                  "text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed " +
                  "disabled:opacity-50 disabled:hover:bg-transparent qc-dark:text-neutral-200 " +
                  "qc-dark:hover:bg-neutral-700 qc-dark:disabled:hover:bg-transparent " +
                  "enabled:cursor-pointer"
                }
              >
                <svg
                  className={`h-4 w-4 ${isRegeneratingTitle ? "animate-spin" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d={
                      "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3" +
                      ".183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3" +
                      ".181 3.182m0-4.991v4.99"
                    }
                  />
                </svg>
                {isRegeneratingTitle ? "正在生成标题..." : "更新标题"}
              </button>
              <button
                type="button"
                onClick={handleArchive}
                disabled={!convId}
                className={
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm " +
                  "text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed " +
                  "disabled:opacity-50 disabled:hover:bg-transparent qc-dark:text-neutral-200 " +
                  "qc-dark:hover:bg-neutral-700 qc-dark:disabled:hover:bg-transparent " +
                  "enabled:cursor-pointer"
                }
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d={
                      "M5 8h14M5 8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1a2 2 0 0 1-2" +
                      " 2M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8m-9 4h4"
                    }
                  />
                </svg>
                归档
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setDeleteOpen(true);
                }}
                disabled={!convId}
                className={
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 " +
                  "hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 " +
                  "disabled:hover:bg-transparent qc-dark:text-red-400 qc-dark:hover:bg-red-950 " +
                  "qc-dark:disabled:hover:bg-transparent enabled:cursor-pointer"
                }
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d={
                      "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v" +
                      "6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    }
                  />
                </svg>
                删除会话
              </button>
            </div>
          )}

          <div className="relative shrink-0" ref={sessionsRef}>
            <button
              ref={sessionsTriggerRef}
              type="button"
              data-no-drag
              onClick={openSessionsMenu}
              aria-label="选择会话"
              title="选择会话"
              className={iconButtonClass}
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m8 3-4 4 4 4M4 7h16m-4 14 4-4-4-4M20 17H4" />
              </svg>
            </button>

            {sessionsOpen && (
              <div
                className={
                  "absolute right-0 top-9 z-50 max-h-64 w-56 overflow-y-auto rounded-lg border " +
                  "border-neutral-200 bg-white py-1 shadow-lg qc-dark:border-neutral-600 " +
                  "qc-dark:bg-neutral-800"
                }
              >
                {sessionsLoading ? (
                  <p className="px-3 py-2 text-xs text-muted">加载中...</p>
                ) : sessions.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-muted">暂无对话</p>
                ) : (
                  sessions.map((session) => {
                    const active = session.id === convId;
                    return (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => handleSelectSession(session.id)}
                        className={`flex w-full cursor-pointer items-center px-3 py-1.5 text-left text-sm ${
                          active
                            ? "bg-hover text-ink"
                            : "text-neutral-700 hover:bg-neutral-100 " +
                              "qc-dark:text-neutral-200 qc-dark:hover:bg-neutral-700"
                        }`}
                      >
                        <span className="truncate">{session.title}</span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          <button
            ref={triggerRef}
            type="button"
            data-no-drag
            onClick={() => {
              setSessionsOpen(false);
              setMenuOpen((v) => !v);
            }}
            className={iconButtonClass}
            aria-label="更多操作"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
          </button>
        </div>

        {copyToast && (
          <div
            className={
              "pointer-events-none absolute right-3 top-12 z-50 rounded-md bg-neutral-800 " +
              "px-2.5 py-1 text-xs text-white shadow-lg qc-dark:bg-neutral-200 " +
              "qc-dark:text-neutral-800"
            }
          >
            已复制
          </div>
        )}
        {regenError && (
          <div
            data-no-drag
            className={
              "absolute right-3 top-12 z-50 flex max-w-sm items-center gap-2 rounded-lg " +
              "border border-line bg-elevated px-3 py-2 text-xs text-ink-secondary " +
              "shadow-lg"
            }
          >
            <span>{regenError}</span>
            {regenError.includes("小文本任务模型") && (
              <button
                type="button"
                onClick={() => {
                  setRegenError(null);
                  onOpenTitleModelSettings();
                }}
                className="shrink-0 cursor-pointer font-medium text-primary hover:underline"
              >
                选择小文本任务模型
              </button>
            )}
          </div>
        )}
      </div>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDeleteConfirm}
        title="确认删除"
        footer={
          <>
            <ModalButton onClick={() => setDeleteOpen(false)}>取消</ModalButton>
            <ModalButton variant="danger" onClick={handleDeleteConfirm}>
              删除
            </ModalButton>
          </>
        }
      >
        <p className="text-[13px] leading-[20px] text-ink-secondary">
          确定要删除对话「<span className="font-medium text-ink">{title}</span>」吗？删除后无法恢复。
        </p>
      </Modal>
    </>
  );
}
