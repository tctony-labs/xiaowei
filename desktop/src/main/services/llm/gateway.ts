import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  type ApiKeyUpdate,
  ConfiguredProviderSchema,
  ListModelsRequestSchema,
  Llm,
  ModelInput,
  ModelSettings,
  ModelSettingsChangedSchema,
  ModelSettingsSnapshotSchema,
  type ConfiguredModel as WireModel,
  type ConfiguredProvider as WireProvider,
} from "xiaowei-contracts";
import { bindHandlers, bindStreamClient, bindStreamHandlers, GatewayFailure } from "xiaowei-gateway";
import type { GatewayHost } from "xiaowei-gateway/host";
import { defaultContextWindow, defaultMaxTokens } from "../../../shared/llm-models";
import {
  type ConfiguredModel,
  type ConfiguredProvider,
  cleanDefaults,
  type ModelConfigDocument,
  normalizeConfig,
  resolveKey,
  resolveModels,
  writeConfig,
} from "./config";
import { encodeModels } from "./shared/configuration-codec";
import { invalidConfig, type ResolvedModelConfig } from "./shared/models";

function parse(value: string | undefined) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    invalidConfig();
  }
}

function decodeModel(model: WireModel): ConfiguredModel {
  if (!model.cost && model.costTiers.length) invalidConfig();
  return {
    id: model.id,
    modelId: model.modelId,
    name: model.name || undefined,
    input: model.input.length
      ? model.input.map((input) => {
          if (input === ModelInput.TEXT) return "text";
          if (input === ModelInput.IMAGE) return "image";
          return invalidConfig();
        })
      : ["text"],
    reasoning: model.reasoning,
    thinkingLevelMap: parse(model.thinkingLevelMapJson),
    contextWindow: model.contextWindow ?? defaultContextWindow,
    maxTokens: model.maxTokens ?? defaultMaxTokens,
    headers: model.headers,
    compat: parse(model.compatJson),
    samplingParams: parse(model.samplingParamsJson),
    cost: model.cost
      ? {
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cacheRead,
          cacheWrite: model.cost.cacheWrite,
          tiers: model.costTiers.map((tier) => {
            if (!tier.rates) invalidConfig();
            return {
              inputTokensAbove: tier.inputTokensAbove,
              input: tier.rates.input,
              output: tier.rates.output,
              cacheRead: tier.rates.cacheRead,
              cacheWrite: tier.rates.cacheWrite,
            };
          }),
        }
      : undefined,
  };
}

function decodeProvider(value: WireProvider, key: ApiKeyUpdate | undefined, saved?: ConfiguredProvider) {
  let apiKey: string | undefined;
  switch (key?.operation.case) {
    case "preserve":
      apiKey = saved?.apiKey;
      break;
    case "replace":
      apiKey = key.operation.value;
      break;
    case "clear":
      apiKey = undefined;
      break;
    default:
      return invalidConfig();
  }
  return {
    id: value.id,
    name: value.name,
    preset: value.preset,
    provider: value.provider,
    api: value.api as ConfiguredProvider["api"],
    baseUrl: value.baseUrl,
    apiKey,
    apiKeyEnv: value.apiKeyEnv || undefined,
    supportsWebSocket: value.supportsWebSocket,
    transport: value.transport as ConfiguredProvider["transport"],
    models: value.models.map(decodeModel),
  };
}

export function registerModelSettings(
  host: GatewayHost,
  initial: { path: string; document: ModelConfigDocument },
  updateModels: (models: readonly ResolvedModelConfig[]) => Promise<void>,
  env: Readonly<Record<string, string | undefined>>,
  persist = writeConfig,
) {
  let document = normalizeConfig(initial.document);
  let revision = 1n;
  let appliedRevision = revision;
  let applicationError = "";
  let applied = resolveModels(document, env);
  let queue: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;

  function snapshot() {
    return create(ModelSettingsSnapshotSchema, {
      revision,
      appliedRevision,
      applicationError,
      defaults: document.defaults,
      providers: document.providers.map((provider) => {
        const key = resolveKey(provider, env);
        const encoded = encodeModels(
          resolveModels(
            { version: 1, defaults: {}, providers: [{ ...provider, apiKey: "encoding", apiKeyEnv: undefined }] },
            {},
          ),
        ).models;
        return create(ConfiguredProviderSchema, {
          id: provider.id,
          name: provider.name,
          preset: provider.preset,
          provider: provider.provider,
          api: provider.api,
          baseUrl: provider.baseUrl,
          apiKeyEnv: provider.apiKeyEnv,
          hasApiKey: Boolean(provider.apiKey),
          supportsWebSocket: provider.supportsWebSocket,
          transport: provider.transport,
          unavailableReason: key ? "" : "API Key 环境变量没有值，且未配置 API Key",
          models: encoded.map((model, index) => ({
            id: model.id,
            modelId: model.modelId,
            name: provider.models[index].name ?? "",
            input: model.input,
            reasoning: model.reasoning,
            thinkingLevelMapJson: model.thinkingLevelMapJson,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            headers: model.headers,
            compatJson: model.compatJson,
            samplingParamsJson: model.samplingParamsJson,
            cost: provider.models[index].cost ? model.cost : undefined,
            costTiers: provider.models[index].cost ? model.costTiers : [],
          })),
        });
      }),
    });
  }

  function publish() {
    owner.publish(
      ModelSettingsChangedSchema.typeName,
      toBinary(ModelSettingsChangedSchema, create(ModelSettingsChangedSchema, { snapshot: snapshot() })),
    );
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new GatewayFailure({ code: "OWNER_UNAVAILABLE", message: "Settings closed" }));
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  function checkRevision(expected: bigint) {
    if (expected !== revision) throw new GatewayFailure({ code: "CONFLICT", message: "配置已更新，请刷新后再保存" });
  }

  async function apply(models: ResolvedModelConfig[]) {
    try {
      if (applicationError || !isDeepStrictEqual(models, applied)) await updateModels(models);
      applied = structuredClone(models);
      appliedRevision = revision;
      applicationError = "";
    } catch {
      applicationError = "配置已保存，但尚未应用，请重试";
    }
    publish();
    return snapshot();
  }

  async function commit(next: ModelConfigDocument) {
    const normalized = normalizeConfig({ ...next, defaults: {} });
    normalized.defaults = { ...next.defaults };
    cleanDefaults(normalized);
    const models = resolveModels(normalized, env);
    encodeModels(models);
    try {
      await persist(initial.path, normalized);
    } catch {
      throw new GatewayFailure({ code: "HANDLER_ERROR", message: "保存模型配置失败" });
    }
    document = normalized;
    revision += 1n;
    return apply(models);
  }

  const handlers = bindHandlers(ModelSettings, {
    get: () => snapshot(),
    saveProvider: (request) =>
      enqueue(async () => {
        checkRevision(request.expectedRevision);
        if (!request.provider) invalidConfig();
        const requestedId = request.provider.id;
        const saved = document.providers.find((provider) => provider.id === requestedId);
        if (request.provider.id && !saved) invalidConfig();
        const next = decodeProvider(request.provider, request.key, saved);
        next.id ||= randomUUID();
        for (const model of next.models) {
          if (model.id && !saved?.models.some((entry) => entry.id === model.id)) invalidConfig();
          model.id ||= randomUUID();
        }
        const providers = saved
          ? document.providers.map((provider) => (provider.id === saved.id ? next : provider))
          : [...document.providers, next];
        return commit({ ...structuredClone(document), providers });
      }),
    deleteProvider: (request) =>
      enqueue(async () => {
        checkRevision(request.expectedRevision);
        if (!document.providers.some((provider) => provider.id === request.providerId)) invalidConfig();
        return commit({
          ...structuredClone(document),
          providers: document.providers.filter((provider) => provider.id !== request.providerId),
        });
      }),
    updateDefaults: (request) =>
      enqueue(async () => {
        checkRevision(request.expectedRevision);
        if (!request.defaults) invalidConfig();
        const defaults = {
          modelRef: request.defaults.modelRef || undefined,
          smallTextModelRef: request.defaults.smallTextModelRef || undefined,
          thinkingLevel: request.defaults.thinkingLevel || undefined,
        };
        const next = { ...structuredClone(document), defaults };
        normalizeConfig(next);
        return commit(next);
      }),
    reapply: () => enqueue(() => apply(resolveModels(document, env))),
  });
  const streams = bindStreamHandlers(ModelSettings, {
    async *listModels(request, client, signal) {
      if (!request.provider) invalidConfig();
      const requestedId = request.provider.id;
      const saved = document.providers.find((provider) => provider.id === requestedId);
      if (request.provider.id && !saved) invalidConfig();
      const draft = decodeProvider({ ...request.provider, models: [] }, request.key, saved);
      draft.id ||= "draft";
      // Catalog does not depend on the editor's display name or model list.
      draft.name ||= "draft";
      const provider = normalizeConfig({ version: 1, providers: [draft], defaults: {} }).providers[0];
      const apiKey = resolveKey(provider, env);
      if (!apiKey) throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "API Key 不可用" });
      const catalog = bindStreamClient(Llm, client);
      const stream = await catalog.modelCatalog(
        create(ListModelsRequestSchema, {
          connection: { api: provider.api, baseUrl: provider.baseUrl, apiKey },
        }),
        { signal },
      );
      try {
        yield* stream;
      } finally {
        await stream.cancel();
      }
    },
  });
  const owner = host.registerOwner(
    "model-settings",
    [...handlers, ...streams],
    [{ name: ModelSettingsChangedSchema.typeName, policy: "coalesce", validate() {}, matches: () => true }],
  );
  return {
    close() {
      closing ??= (async () => {
        await queue;
        await owner.close();
      })();
      return closing;
    },
  };
}
