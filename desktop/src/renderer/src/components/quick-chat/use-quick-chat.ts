import { create, fromBinary } from "@bufbuild/protobuf";
import { useEffect, useRef, useState } from "react";
import {
  EmptySchema,
  GenerateRequestSchema,
  ModelSettingsChangedSchema,
  type ModelSettingsSnapshot,
} from "xiaowei-contracts";
import type { Subscription } from "xiaowei-gateway";
import type { Services } from "../../services";
import { type ChatEntry, replyAccumulator, userEntry } from "./chat-messages";

export function useQuickChat(services: Services) {
  const [snapshot, setSnapshot] = useState<ModelSettingsSnapshot>();
  const [configError, setConfigError] = useState("");
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [generating, setGenerating] = useState(false);
  const entries = useRef<ChatEntry[]>([]);
  const active = useRef<{ id: string; controller: AbortController } | null>(null);

  function publish(next: ChatEntry[]) {
    entries.current = next;
    setMessages(next);
  }

  useEffect(() => {
    let disposed = false;
    let subscription: Subscription | undefined;
    let latest: ModelSettingsSnapshot | undefined;
    let events = 0;
    setSnapshot(undefined);
    setConfigError("");
    function accept(next: ModelSettingsSnapshot) {
      if (disposed || (latest && latest.revision > next.revision)) return;
      latest = next;
      setSnapshot(next);
      setConfigError("");
    }
    void (async () => {
      const handle = await services.getGateway().subscribe(ModelSettingsChangedSchema.typeName, undefined, (bytes) => {
        events++;
        const next = fromBinary(ModelSettingsChangedSchema, bytes).snapshot;
        if (next) accept(next);
      });
      if (disposed) {
        handle.close();
        return;
      }
      subscription = handle;
      const before = events;
      const next = await services.getModelSettings().get(create(EmptySchema));
      if (before === events) accept(next);
    })().catch(() => {
      if (!disposed && !latest) setConfigError("加载默认模型失败，请重启应用后重试。");
    });
    return () => {
      disposed = true;
      subscription?.close();
      const run = active.current;
      active.current = null;
      run?.controller.abort();
    };
  }, [services]);

  const modelRef = snapshot?.defaults?.modelRef;
  const provider = snapshot?.providers.find((item) => item.models.some((model) => model.id === modelRef));
  const error =
    configError ||
    (snapshot
      ? !modelRef
        ? "未设置默认模型，请先在设置 → 模型中配置。"
        : !provider
          ? "默认模型已不可用，请在设置中重新配置。"
          : provider.unavailableReason
            ? "默认模型的凭据不可用，请检查提供商配置。"
            : snapshot.applicationError
              ? "模型配置尚未应用，请在设置中处理。"
              : ""
      : "");
  const configured = !!snapshot && !error;

  function stop() {
    const run = active.current;
    if (!run) return;
    active.current = null;
    run.controller.abort();
    publish(entries.current.map((entry) => (entry.id === run.id ? { ...entry, status: "cancelled" } : entry)));
    setGenerating(false);
  }

  async function send() {
    if (!configured || !modelRef || !draft.trim() || active.current) return;
    const user = userEntry(draft);
    const history = [...entries.current, user].flatMap((entry) => (entry.history ? [entry.history] : []));
    const run = { id: crypto.randomUUID(), controller: new AbortController() };
    active.current = run;
    const accumulator = replyAccumulator(run.id);
    publish([...entries.current, user, { id: run.id, role: "assistant", text: "", status: "generating" }]);
    setDraft("");
    setGenerating(true);
    const replace = (reply: ChatEntry) => {
      if (active.current === run) publish(entries.current.map((entry) => (entry.id === run.id ? reply : entry)));
    };
    try {
      const stream = await services.getLlm().generate(
        create(GenerateRequestSchema, {
          modelRef,
          messages: history,
          options: { reasoning: snapshot?.defaults?.thinkingLevel || undefined },
        }),
        { signal: run.controller.signal },
      );
      if (active.current !== run) {
        await stream.cancel();
        return;
      }
      try {
        for await (const event of stream) {
          if (active.current !== run) break;
          replace(accumulator.accept(event));
        }
        if (active.current === run && !accumulator.terminal) throw new Error("回复流意外中断，请重试。");
      } finally {
        await stream.cancel();
      }
    } catch (cause) {
      if (active.current === run) {
        const reply = entries.current.find((entry) => entry.id === run.id);
        if (reply) {
          replace({
            ...reply,
            history: undefined,
            status: "failed",
            error:
              cause instanceof Error && ["本次对话不支持工具调用。", "回复流意外中断，请重试。"].includes(cause.message)
                ? cause.message
                : "模型请求失败，请检查模型配置后重试。",
          });
        }
      }
    } finally {
      if (active.current === run) {
        active.current = null;
        setGenerating(false);
      }
    }
  }

  return {
    messages,
    draft,
    generating,
    configured,
    loading: !snapshot && !configError,
    error,
    onDraftChange: setDraft,
    onSend: () => void send(),
    onStop: stop,
    onNewConversation: () => {
      stop();
      publish([]);
      setDraft("");
    },
  };
}
