import { create } from "@bufbuild/protobuf";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentSessionSummary,
  DeleteSessionRequestSchema,
  DeleteSessionStatus,
  GetSessionRetentionPolicyRequestSchema,
  ListSessionsRequestSchema,
  type SessionRetentionPolicy,
  SetSessionArchivedRequestSchema,
  SetSessionRetentionPolicyRequestSchema,
} from "xiaowei-contracts";
import { services as defaultServices, type Services } from "../../services";
import { type ArchivedSession, ArchiveSettings } from "./ArchiveSettings";

export function ArchiveSettingsPage({ services = defaultServices }: { services?: Services }) {
  const api = services.getAgent();
  const [policy, setPolicy] = useState<SessionRetentionPolicy>();
  const [policySaving, setPolicySaving] = useState(false);
  const [policyError, setPolicyError] = useState("");
  const savingPolicy = useRef(false);
  const policyGeneration = useRef(0);
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [continuation, setContinuation] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const generation = useRef(0);
  const operating = useRef(false);
  const alive = useRef(false);

  const load = useCallback(
    async (position = "") => {
      const current = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const page = await api.listSessions(
          create(ListSessionsRequestSchema, {
            archived: true,
            query,
            continuation: position,
          }),
        );
        if (!alive.current || current !== generation.current) return;
        setSessions((previous) =>
          position
            ? [
                ...previous,
                ...page.sessions.filter((next) => !previous.some((item) => item.sessionId === next.sessionId)),
              ]
            : page.sessions,
        );
        setContinuation(page.continuation);
      } catch (cause) {
        if (alive.current && current === generation.current) setError(`加载归档失败：${String(cause)}`);
      } finally {
        if (alive.current && current === generation.current) setLoading(false);
      }
    },
    [api, query],
  );

  useEffect(() => {
    alive.current = true;
    setSessions([]);
    setContinuation("");
    void load();
    const focus = () => {
      if (!operating.current) void load();
    };
    window.addEventListener("focus", focus);
    return () => {
      alive.current = false;
      generation.current++;
      window.removeEventListener("focus", focus);
    };
  }, [load]);

  const loadPolicy = useCallback(async () => {
    const current = ++policyGeneration.current;
    setPolicyError("");
    try {
      const response = await api.getSessionRetentionPolicy(create(GetSessionRetentionPolicyRequestSchema));
      if (alive.current && current === policyGeneration.current) setPolicy(response);
    } catch (cause) {
      if (alive.current && current === policyGeneration.current) {
        setPolicyError(`加载自动归档设置失败：${String(cause)}`);
      }
    }
  }, [api]);

  useEffect(() => {
    void loadPolicy();
    const focus = () => {
      if (!savingPolicy.current) void loadPolicy();
    };
    window.addEventListener("focus", focus);
    return () => {
      policyGeneration.current++;
      window.removeEventListener("focus", focus);
    };
  }, [loadPolicy]);

  async function savePolicy(archiveDays: number, deleteDays: number) {
    if (savingPolicy.current || !policy) return;
    savingPolicy.current = true;
    policyGeneration.current++;
    setPolicySaving(true);
    setPolicyError("");
    try {
      const response = await api.setSessionRetentionPolicy(
        create(SetSessionRetentionPolicyRequestSchema, {
          policy: { archiveAfterDays: archiveDays, deleteAfterDays: deleteDays },
        }),
      );
      if (alive.current) setPolicy(response);
    } catch (cause) {
      if (alive.current) setToast(`保存自动归档设置失败：${String(cause)}`);
    } finally {
      savingPolicy.current = false;
      if (alive.current) setPolicySaving(false);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function operate(work: () => Promise<string>) {
    if (operating.current) return;
    operating.current = true;
    setBusy(true);
    setToast("");
    try {
      const message = await work();
      if (alive.current) setToast(message);
    } catch (cause) {
      if (alive.current) setToast(`操作失败：${String(cause)}`);
    } finally {
      if (alive.current) {
        await load();
        setBusy(false);
      }
      operating.current = false;
    }
  }

  function restore(id: string) {
    const session = sessions.find((item) => item.sessionId === id);
    if (!session) return;
    void operate(async () => {
      await api.setSessionArchived(
        create(SetSessionArchivedRequestSchema, {
          sessionId: id,
          archived: false,
          expectedArchiveRevision: session.archiveRevision,
        }),
      );
      return "已恢复对话";
    });
  }

  function remove(targets: ArchivedSession[]) {
    void operate(async () => {
      const response = await api.deleteSession(
        create(DeleteSessionRequestSchema, {
          targets: targets.map((target) => ({
            sessionId: target.id,
            expectedMetadataRevision: target.metadataRevision,
            expectedArchiveRevision: target.archiveRevision,
          })),
        }),
      );
      const deleted = response.results.filter((result) => result.status === DeleteSessionStatus.DELETED).length;
      const skipped = response.results.filter((result) => result.status === DeleteSessionStatus.SKIPPED).length;
      const failed = response.results.find((result) => result.status === DeleteSessionStatus.FAILED);
      const pending = response.results.filter((result) => result.status === DeleteSessionStatus.NOT_EXECUTED).length;
      if (failed) return `已删除 ${deleted} 条，跳过 ${skipped} 条，未执行 ${pending} 条。删除失败：${failed.error}`;
      if (skipped) return `已删除 ${deleted} 条，跳过 ${skipped} 条（会话状态已变化或已不存在）`;
      return `已删除 ${deleted} 条对话`;
    });
  }

  return (
    <>
      <ArchiveSettings
        archiveDays={policy?.archiveAfterDays}
        deleteDays={policy?.deleteAfterDays}
        onChange={(archiveDays, deleteDays) => void savePolicy(archiveDays, deleteDays)}
        policyDisabled={!policy || policySaving}
        policyError={policyError}
        onPolicyRetry={() => void loadPolicy()}
        sessions={sessions.map((session) => ({
          id: session.sessionId,
          title: session.title || "新的对话",
          time: new Date(Number(session.updatedAtMs)).toLocaleString(),
          metadataRevision: session.metadataRevision,
          archiveRevision: session.archiveRevision,
        }))}
        query={query}
        onQueryChange={setQuery}
        loading={loading}
        busy={busy}
        hasMore={!!continuation}
        onMore={() => void load(continuation)}
        error={error}
        onRetry={() => void load()}
        onRestore={restore}
        onDelete={remove}
      />
      {toast && (
        <div
          role="status"
          className="absolute bottom-4 left-1/2 z-30 max-w-[90%] -translate-x-1/2
            rounded-lg bg-elevated px-4 py-2 text-sm shadow-lg"
        >
          {toast}
        </div>
      )}
    </>
  );
}
