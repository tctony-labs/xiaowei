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
  workspace: string;
  time: string;
  kind: "home" | "wiki" | "folder";
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
}: {
  archiveDays: number;
  deleteDays: number;
  onChange: (archiveDays: number, deleteDays: number) => void;
  sessions: ArchivedSession[];
  loading: boolean;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  initialDelete?: string;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [target, setTarget] = useState(initialDelete ?? "");
  const filtered = sessions.filter((s) => `${s.title} ${s.workspace}`.toLowerCase().includes(query.toLowerCase()));
  const selected = sessions.find((s) => s.id === target);
  function remove() {
    onDelete(target);
    setTarget("");
  }
  return (
    <SettingsTabLayout title="对话归档">
      <SettingCard>
        <SettingRow title="归档不活跃的对话">
          <Select
            value={archiveDays}
            options={[1, 3, 7, 15].map((value) => ({ value, label: `${value} 天` }))}
            onChange={(days) => onChange(days, deleteDays)}
          />
        </SettingRow>
        <SettingRow title="清理不活跃的对话">
          <Select
            value={deleteDays}
            options={[
              { value: 0, label: "关闭" },
              { value: 30, label: "1 个月" },
              { value: 90, label: "3 个月" },
              { value: 180, label: "6 个月" },
              { value: 365, label: "1 年" },
            ]}
            onChange={(days) => onChange(archiveDays, days)}
          />
        </SettingRow>
      </SettingCard>
      <div className="flex flex-col gap-2">
        <input
          type="text"
          placeholder="搜索标题或工作区"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-md border border-subtle bg-elevated px-3 py-1.5 text-[13px] outline-none
              focus:border-primary"
        />
        <div className="flex flex-col">
          {loading && (
            <p role="status" className="px-3 py-6 text-center text-[12px] text-muted">
              加载中…
            </p>
          )}
          {!loading && !filtered.length && (
            <p className="px-3 py-6 text-center text-[12px] text-muted">
              {sessions.length ? "未找到匹配的会话" : "暂无归档会话"}
            </p>
          )}
          {filtered.map((session) => (
            <div key={session.id} className="group flex items-center gap-2 rounded-md px-3 py-2 hover:bg-hover">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] leading-[20px]">{session.title}</p>
                <p className="flex items-center gap-1 text-[12px] leading-[18px] text-muted">
                  <span>{session.time}</span>
                  <span>·</span>
                  <WorkspaceIcon
                    isWiki={session.kind === "wiki"}
                    isHome={session.kind === "home"}
                    className="h-3 w-3 shrink-0"
                  />
                  <span className="truncate">{session.workspace}</span>
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
                  className="cursor-pointer rounded px-2 py-1 text-[12px] text-ink-secondary hover:bg-hover"
                >
                  恢复
                </button>
                <button
                  type="button"
                  title="永久删除"
                  onClick={() => setTarget(session.id)}
                  className="cursor-pointer rounded px-2 py-1 text-[12px] text-danger hover:bg-danger/10"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <Modal
        open={!!target}
        onClose={() => setTarget("")}
        title="确认永久删除"
        onConfirm={remove}
        footer={
          <>
            <ModalButton onClick={() => setTarget("")}>取消</ModalButton>
            <ModalButton variant="danger" onClick={remove}>
              删除
            </ModalButton>
          </>
        }
      >
        <p className="text-[13px] leading-[20px] text-ink-secondary">
          确定要永久删除归档会话「<span className="font-medium text-ink">{selected?.title}</span>」吗？删除后无法恢复。
        </p>
      </Modal>
    </SettingsTabLayout>
  );
}
