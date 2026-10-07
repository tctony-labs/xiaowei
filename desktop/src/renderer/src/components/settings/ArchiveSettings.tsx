import { useState } from "react";
import Modal, { ModalButton } from "../Modal";
import Select from "./Select";
import SettingCard from "./SettingCard";
import SettingRow from "./SettingRow";
import SettingsTabLayout from "./SettingsTabLayout";
import WorkspaceIcon from "./WorkspaceIcon";

export interface ArchivedSession {
  id: string;
  title: string;
  workspace?: string;
  time: string;
  kind?: "home" | "wiki" | "folder";
  metadataRevision?: bigint;
  archiveRevision?: bigint;
}

export function ArchiveSettings({
  archiveDays,
  deleteDays,
  onChange,
  sessions,
  loading,
  onRestore,
  onDelete,
  initialDelete,
  initialQuery = "",
  showPolicies = true,
  policyDisabled = false,
  policyError,
  onPolicyRetry,
  query: remoteQuery,
  onQueryChange,
  busy = false,
  hasMore = false,
  onMore,
  error,
  onRetry,
}: {
  archiveDays?: number;
  deleteDays?: number;
  onChange?: (archiveDays: number, deleteDays: number) => void;
  sessions: ArchivedSession[];
  loading: boolean;
  onRestore: (id: string) => void;
  onDelete: (targets: ArchivedSession[]) => void;
  initialDelete?: string;
  initialQuery?: string;
  showPolicies?: boolean;
  policyDisabled?: boolean;
  policyError?: string;
  onPolicyRetry?: () => void;
  query?: string;
  onQueryChange?: (query: string) => void;
  busy?: boolean;
  hasMore?: boolean;
  onMore?: () => void;
  error?: string;
  onRetry?: () => void;
}) {
  const [localQuery, setLocalQuery] = useState(initialQuery);
  const query = remoteQuery ?? localQuery;
  const filtered = onQueryChange
    ? sessions
    : sessions.filter((s) => `${s.title} ${s.workspace ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const [targets, setTargets] = useState<ArchivedSession[]>(() =>
    sessions.filter((session) => session.id === initialDelete),
  );

  function remove() {
    if (!targets.length || busy) return;
    onDelete(targets);
    setTargets([]);
  }

  return (
    <SettingsTabLayout title="对话归档">
      {showPolicies && (
        <SettingCard>
          <SettingRow title="归档不活跃的对话">
            <Select
              disabled={policyDisabled}
              ariaLabel="归档不活跃的对话"
              value={archiveDays ?? 3}
              options={[1, 3, 7, 15].map((value) => ({ value, label: `${value} 天` }))}
              onChange={(days) => onChange?.(days, deleteDays ?? 0)}
            />
          </SettingRow>
          <SettingRow title="清理不活跃的对话">
            <Select
              disabled={policyDisabled}
              ariaLabel="清理不活跃的对话"
              value={deleteDays ?? 0}
              options={[
                { value: 0, label: "关闭" },
                { value: 30, label: "1 个月" },
                { value: 90, label: "3 个月" },
                { value: 180, label: "6 个月" },
                { value: 365, label: "1 年" },
              ]}
              onChange={(days) => onChange?.(archiveDays ?? 3, days)}
            />
          </SettingRow>
          {policyError && (
            <div role="alert" className="px-3 pb-3 text-[12px] text-danger">
              {policyError}
              <button type="button" onClick={onPolicyRetry} className="ml-2">
                重试
              </button>
            </div>
          )}
        </SettingCard>
      )}
      <SettingCard>
        <div className="flex flex-col gap-2 p-3">
          <input
            type="text"
            placeholder={sessions.some((session) => session.workspace) ? "搜索标题或工作区" : "搜索标题"}
            value={query}
            onChange={(e) => (onQueryChange ?? setLocalQuery)(e.target.value)}
            disabled={busy}
            className="w-full rounded-md border border-subtle bg-elevated px-3 py-1.5 text-[13px] outline-none
              focus:border-primary"
          />
          {error && (
            <div role="alert" className="px-3 text-[12px] text-danger">
              {error}
              <button type="button" onClick={onRetry} disabled={loading || busy} className="ml-2 cursor-pointer">
                重试
              </button>
            </div>
          )}
          <div className="flex flex-col">
            {loading && (
              <p role="status" className="px-3 py-6 text-center text-[12px] text-muted">
                加载中…
              </p>
            )}
            {!loading && !error && !filtered.length && (
              <p className="px-3 py-6 text-center text-[12px] text-muted">
                {query ? "未找到匹配的会话" : "暂无归档会话"}
              </p>
            )}
            {filtered.map((session) => (
              <div key={session.id} className="group flex items-center gap-2 rounded-md px-3 py-2 hover:bg-hover">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] leading-[20px]">{session.title}</p>
                  <p className="flex items-center gap-1 text-[12px] leading-[18px] text-muted">
                    <span>{session.time}</span>
                    {session.workspace && (
                      <>
                        <span>·</span>
                        <WorkspaceIcon
                          isWiki={session.kind === "wiki"}
                          isHome={session.kind === "home"}
                          className="h-3 w-3 shrink-0"
                        />
                        <span className="truncate">{session.workspace}</span>
                      </>
                    )}
                  </p>
                </div>
                <div
                  className="flex shrink-0 items-center gap-1 opacity-0
                group-hover:opacity-100 focus-within:opacity-100"
                >
                  <button
                    type="button"
                    title="恢复对话"
                    onClick={() => onRestore(session.id)}
                    disabled={busy || loading}
                    className="cursor-pointer rounded px-2 py-1 text-[12px] text-ink-secondary hover:bg-hover"
                  >
                    恢复
                  </button>
                  <button
                    type="button"
                    title="永久删除"
                    onClick={() => setTargets([session])}
                    disabled={busy || loading}
                    className="cursor-pointer rounded px-2 py-1 text-[12px] text-danger hover:bg-danger/10"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
          {hasMore && (
            <button
              type="button"
              onClick={onMore}
              disabled={loading || busy}
              className="cursor-pointer px-3 py-2 text-[12px] text-muted hover:bg-hover"
            >
              加载更多
            </button>
          )}
        </div>
      </SettingCard>
      <Modal
        open={!!targets.length}
        onClose={() => setTargets([])}
        title="确认永久删除"
        onConfirm={remove}
        footer={
          <>
            <ModalButton onClick={() => setTargets([])}>取消</ModalButton>
            <ModalButton variant="danger" onClick={remove}>
              删除
            </ModalButton>
          </>
        }
      >
        <p className="text-[13px] leading-[20px] text-ink-secondary">
          确定要永久删除归档会话「
          <span className="font-medium text-ink">{targets[0]?.title}</span>」吗？ 删除后无法恢复。
        </p>
      </Modal>
    </SettingsTabLayout>
  );
}
