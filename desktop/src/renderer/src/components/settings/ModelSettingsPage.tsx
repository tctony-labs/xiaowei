import { create, fromBinary } from "@bufbuild/protobuf";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ConfiguredProvider,
  ConfiguredProviderSchema,
  DeleteProviderRequestSchema,
  DiscoverModelsRequestSchema,
  EmptySchema,
  ModelInput,
  ModelSettingsChangedSchema,
  type ModelSettingsSnapshot,
  SaveProviderRequestSchema,
  UpdateModelDefaultsRequestSchema,
} from "xiaowei-contracts";
import type { Subscription } from "xiaowei-gateway";
import { defaultContextWindow } from "../../../../shared/llm-models";
import type { Services } from "../../services";
import { ModelSettings, type ModelValues, type Provider } from "./ModelSettings";

function toProvider(provider: ConfiguredProvider, revision: bigint): Provider {
  return {
    id: provider.id,
    revision,
    name: provider.name,
    preset: provider.preset ?? null,
    provider: provider.provider,
    baseUrl: provider.baseUrl,
    protocol: provider.api,
    transport: provider.transport,
    supportsWebSocket: provider.supportsWebSocket,
    hasApiKey: provider.hasApiKey,
    apiKeyEnv: provider.apiKeyEnv,
    unavailableReason: provider.unavailableReason,
    models: provider.models.map((model) => model.modelId),
    modelContextWindows: Object.fromEntries(
      provider.models.map((model) => [model.modelId, model.contextWindow ?? defaultContextWindow]),
    ),
    modelContextLimits: {},
    modelConfigs: Object.fromEntries(
      provider.models.map((model) => [
        model.modelId,
        {
          localRef: model.id,
          original: model,
          name: model.name || undefined,
          supportsImage: model.input.includes(ModelInput.IMAGE),
          reasoning: model.reasoning,
          thinkingLevelMap: model.thinkingLevelMapJson ? JSON.parse(model.thinkingLevelMapJson) : undefined,
          headers: model.headers,
          maxOutput: model.maxTokens,
        },
      ]),
    ),
  };
}

function draft(provider: Provider) {
  return create(ConfiguredProviderSchema, {
    id: provider.id,
    name: provider.name,
    preset: provider.preset ?? undefined,
    provider: provider.provider || provider.preset || "custom",
    api: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv,
    supportsWebSocket: provider.supportsWebSocket,
    transport: provider.transport,
    models: provider.models.map((modelId) => {
      const model = provider.modelConfigs?.[modelId];
      return {
        compatJson: model?.original?.compatJson,
        samplingParamsJson: model?.original?.samplingParamsJson,
        cost: model?.original?.cost,
        costTiers: model?.original?.costTiers,
        id: model?.localRef ?? "",
        modelId,
        name: model?.name ?? "",
        contextWindow: provider.modelContextWindows[modelId],
        maxTokens: model?.maxOutput,
        input: model?.supportsImage ? [ModelInput.TEXT, ModelInput.IMAGE] : [ModelInput.TEXT],
        reasoning: model?.reasoning ?? false,
        thinkingLevelMapJson:
          model?.reasoning && model.thinkingLevelMap ? JSON.stringify(model.thinkingLevelMap) : undefined,
        headers: model?.headers ?? {},
      };
    }),
  });
}

function keyUpdate(provider: Provider, key: string) {
  if (key.trim()) return { operation: { case: "replace" as const, value: key } };
  return {
    operation: provider.hasApiKey ? { case: "preserve" as const, value: {} } : { case: "clear" as const, value: {} },
  };
}

export function ModelSettingsPage({ services }: { services: Services }) {
  const api = services.getModelSettings();
  const [snapshot, setSnapshot] = useState<ModelSettingsSnapshot>();
  const [error, setError] = useState("");
  const active = useRef(false);
  const current = useRef<ModelSettingsSnapshot | undefined>(undefined);

  const accept = useCallback((next: ModelSettingsSnapshot) => {
    if (!active.current || (current.current && next.revision < current.current.revision)) return;
    current.current = next;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    active.current = true;
    let disposed = false;
    let subscription: Subscription | undefined;
    let events = 0;
    void (async () => {
      const handle = await services.getGateway().subscribe(ModelSettingsChangedSchema.typeName, undefined, (bytes) => {
        events++;
        const next = fromBinary(ModelSettingsChangedSchema, bytes).snapshot;
        if (!disposed && next) accept(next);
      });
      if (disposed) {
        handle.close();
        return;
      }
      subscription = handle;
      const before = events;
      const next = await api.get(create(EmptySchema));
      if (!disposed && before === events) accept(next);
    })().catch(() => {
      if (!disposed) setError("加载模型设置失败");
    });
    return () => {
      disposed = true;
      active.current = false;
      subscription?.close();
    };
  }, [api, services, accept]);

  if (!snapshot)
    return (
      <p role="status" className="p-6 text-sm">
        {error || "加载模型设置…"}
      </p>
    );
  const providers = snapshot.providers.map((provider) => toProvider(provider, snapshot.revision));
  const values: ModelValues = {
    defaultModel: snapshot.defaults?.modelRef ?? "",
    smallModel: snapshot.defaults?.smallTextModelRef ?? "",
    reasoning: snapshot.defaults?.thinkingLevel ?? "",
    imageModel: "",
    localEnabled: false,
    localModel: "",
  };

  async function updateDefaults(next: ModelValues) {
    setError("");
    const model = current.current?.providers
      .flatMap((provider) => provider.models)
      .find((model) => model.id === next.defaultModel);
    const map = model?.thinkingLevelMapJson ? JSON.parse(model.thinkingLevelMapJson) : {};
    try {
      accept(
        await api.updateDefaults(
          create(UpdateModelDefaultsRequestSchema, {
            expectedRevision: current.current?.revision,
            defaults: {
              modelRef: next.defaultModel,
              smallTextModelRef: next.smallModel,
              thinkingLevel: model?.reasoning && typeof map[next.reasoning] === "string" ? next.reasoning : "",
            },
          }),
        ),
      );
    } catch {
      if (active.current) setError("保存默认模型失败，请刷新后重试");
    }
  }

  return (
    <>
      {(error || snapshot.applicationError) && (
        <div role="alert" className="px-6 pt-3 text-sm text-danger">
          {error || snapshot.applicationError}
          {snapshot.applicationError && (
            <button
              type="button"
              className="ml-3 cursor-pointer"
              onClick={() => {
                void api
                  .reapply(create(EmptySchema))
                  .then(accept)
                  .catch(() => setError("应用模型配置失败"));
              }}
            >
              重试
            </button>
          )}
        </div>
      )}
      <ModelSettings
        remoteOnly
        values={values}
        providers={providers}
        localModels={[]}
        diskGB={0}
        onChange={(next) => void updateDefaults(next)}
        onSaveProvider={async (provider, key) => {
          const next = await api.saveProvider(
            create(SaveProviderRequestSchema, {
              expectedRevision: provider.revision ?? current.current?.revision,
              provider: draft(provider),
              key: keyUpdate(provider, key),
            }),
          );
          accept(next);
          const saved = next.providers.find((entry) =>
            provider.id ? entry.id === provider.id : entry.name === provider.name,
          );
          if (!saved) throw new Error("保存模型配置失败");
          return toProvider(saved, next.revision);
        }}
        onDeleteProvider={async (id, revision) => {
          accept(
            await api.deleteProvider(
              create(DeleteProviderRequestSchema, {
                providerId: id,
                expectedRevision: revision ?? current.current?.revision,
              }),
            ),
          );
        }}
        onFetchModels={async (provider, key, signal) => {
          const stream = await services.getModelCatalog().listModels(
            create(DiscoverModelsRequestSchema, {
              provider: draft(provider),
              key: keyUpdate(provider, key),
            }),
            { signal },
          );
          const models = [];
          try {
            for await (const page of stream) {
              models.push(
                ...page.models.map((model) => ({
                  id: model.modelId,
                  name: model.name,
                  contextWindow: model.contextWindow,
                  maxOutput: model.maxTokens,
                  supportsImage: model.input.includes(ModelInput.IMAGE),
                  reasoning: model.reasoning,
                  thinkingLevelMap: model.thinkingLevelMapJson ? JSON.parse(model.thinkingLevelMapJson) : undefined,
                })),
              );
            }
          } finally {
            await stream.cancel();
          }
          return models;
        }}
        onSelectLocal={() => {}}
        onOpenDirectory={() => {}}
        onTestImage={async () => {}}
      />
    </>
  );
}
