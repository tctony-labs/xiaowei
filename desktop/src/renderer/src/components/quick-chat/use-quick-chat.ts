import { create, fromBinary } from "@bufbuild/protobuf";
import { useEffect, useState } from "react";
import {
  AgentModelConfigSchema,
  EmptySchema,
  ModelSettingsChangedSchema,
  type ModelSettingsSnapshot,
  OpenSettingsRequestSchema,
  SettingsAnchor,
  WriteClipboardTextRequestSchema,
} from "xiaowei-contracts";
import type { Subscription } from "xiaowei-gateway";
import { thinkingLevels } from "../../../../shared/llm-models";
import type { Services } from "../../services";
import { agentChatClient } from "../agent-chat/client";
import { useSessionViewing } from "../agent-chat/use-session-viewing";

export function useQuickChat(services: Services, viewing = false) {
  const [snapshot, setSnapshot] = useState<ModelSettingsSnapshot>();
  const [configError, setConfigError] = useState("");
  const [draftSelection, setDraftSelection] = useState<{ modelRef: string; reasoning?: string }>();
  const client = agentChatClient(services);
  const [, refresh] = useState(0);
  useSessionViewing(services, client.session?.sessionId, viewing);
  useEffect(() => client.observe(() => refresh((value) => value + 1)), [client]);

  useEffect(() => {
    void client.restoreLatestSession().catch(() => {});
  }, [client]);

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
    };
  }, [services]);

  const defaultModelRef = snapshot?.defaults?.modelRef;
  const defaultProvider = snapshot?.providers.find((item) => item.models.some((model) => model.id === defaultModelRef));
  const provider =
    defaultProvider ?? snapshot?.providers.find((item) => !item.unavailableReason && item.models.length > 0);
  const modelRef = defaultProvider ? defaultModelRef : provider?.models[0]?.id;
  const initialReasoning = defaultProvider ? snapshot?.defaults?.thinkingLevel : undefined;
  const selection = client.session?.config ??
    draftSelection ?? { modelRef: modelRef ?? "", reasoning: initialReasoning };
  const selectedProvider = snapshot?.providers.find((provider) =>
    provider.models.some((m) => m.id === selection.modelRef),
  );
  const selectedModel = selectedProvider?.models.find((model) => model.id === selection.modelRef);
  const modelOptions =
    snapshot?.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        value: model.id,
        label: `${provider.name}/${model.name || model.modelId}`,
      })),
    ) ?? [];
  const supportedReasoning = selectedModel?.reasoning
    ? thinkingLevels.filter((level) => {
        const map = selectedModel.thinkingLevelMapJson ? JSON.parse(selectedModel.thinkingLevelMapJson) : undefined;
        return map ? typeof map[level] === "string" : level !== "off";
      })
    : selectedModel
      ? []
      : undefined;
  const initialError =
    configError ||
    (snapshot
      ? snapshot.applicationError
        ? "模型配置尚未应用，请在设置中处理。"
        : !selection.modelRef
          ? "暂无可用模型，请先在设置 - 模型中配置。"
          : selectedProvider?.unavailableReason
            ? "模型的凭据不可用，请检查提供商配置。"
            : ""
      : "");
  // Existing sessions keep their own reference even when settings / model lookup fails.
  const configured =
    !client.initializing && !!selection.modelRef && (!!client.session || (!!snapshot && !initialError));
  const error = client.session ? client.error : initialError || client.error;
  const modelLabel = client.session?.modelName
    ? [client.session.providerName, client.session.modelName].filter(Boolean).join("/")
    : selection.modelRef;
  const modelHint = client.session?.modelInfoWarning
    ? `${modelLabel} 模型配置获取失败，部分功能可能出现异常`
    : undefined;

  function select(next: { modelRef: string; reasoning?: string }) {
    if (client.session) void client.setConfig(create(AgentModelConfigSchema, next)).catch(() => {});
    else setDraftSelection(next);
  }

  function changeModel(modelRef: string) {
    const model = snapshot?.providers.flatMap((provider) => provider.models).find((model) => model.id === modelRef);
    if (!model) return;
    const map = model.thinkingLevelMapJson ? JSON.parse(model.thinkingLevelMapJson) : undefined;
    const reasoning =
      selection.reasoning &&
      model.reasoning &&
      (map ? typeof map[selection.reasoning] === "string" : selection.reasoning !== "off")
        ? selection.reasoning
        : undefined;
    select({ modelRef, reasoning });
  }

  async function send() {
    if (!configured || !client.draft.trim() || client.busy || client.configuring) return;
    const submitted = client.draft;
    try {
      const sessionId = await client.send(
        submitted,
        create(AgentModelConfigSchema, {
          modelRef: selection.modelRef,
          reasoning: selection.reasoning || undefined,
        }),
      );
      if (client.draftFor(sessionId) === submitted) client.setDraft("", sessionId);
    } catch {
      /* The client keeps uncertain input visible and never automatically resends it. */
    }
  }

  return {
    messages: client.messages,
    sessionId: client.session?.sessionId ?? null,
    title: client.session?.title || undefined,
    onRename: (title: string) => void client.setTitle(title).catch(() => {}),
    isRegeneratingTitle: client.regeneratingTitle,
    onRegenerateTitle: () => client.regenerateTitle(),
    onOpenTitleModelSettings: () => {
      void services
        .getSystem()
        .openSettings(create(OpenSettingsRequestSchema, { anchor: SettingsAnchor.MODEL_PROVIDERS }))
        .catch(() => console.warn("Failed to open title model settings"));
    },
    onCopySessionId: async (id: string) => {
      await services.getSystem().writeClipboardText(create(WriteClipboardTextRequestSchema, { text: id }));
    },
    sessions: client.sessions.map((session) => ({ id: session.sessionId, title: client.sessionTitle(session) })),
    sessionsLoading: client.sessionsLoading,
    sessionsHasMore: !!client.sessionsContinuation,
    onMoreSessions: () => void client.listSessions(true).catch(() => {}),
    onListSessions: () => void client.listSessions().catch(() => {}),
    onArchiveConversation: () => {
      if (client.session) void client.archiveSession(client.session.sessionId, true).catch(() => {});
    },
    onSwitchSession: (id: string) => void client.switchSession(id).catch(() => {}),
    onDeleteConversation: () => void client.deleteConversation().catch(() => {}),
    draft: client.draft,
    generating: client.busy,
    configured,
    modelHint,
    modelOptions,
    selectedModelRef: selection.modelRef,
    modelLabel,
    reasoning: selection.reasoning ?? "",
    supportedReasoning,
    configSaving: client.configuring,
    onModelChange: changeModel,
    onReasoningChange: (reasoning: string) =>
      select({ modelRef: selection.modelRef, reasoning: reasoning || undefined }),
    noModels: !!snapshot && !modelRef && !snapshot.applicationError && !configError,
    loading: client.initializing || (!client.session && !snapshot && !configError),
    error,
    onDraftChange: (text: string) => client.setDraft(text),
    onSend: () => void send(),
    onStop: () => void client.stop().catch(() => {}),
    onNewConversation: () => {
      setDraftSelection(undefined);
      void client.newConversation().catch(() => {});
    },
  };
}
