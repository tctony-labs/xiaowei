import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { defaultContextWindow, defaultMaxTokens, matchThinkingMap } from "../../../shared/llm-models";
import {
  configureModels,
  invalidConfig,
  type ModelConfig,
  type ResolvedModelConfig,
  validateModel,
} from "./shared/models";

export interface ConfiguredModel
  extends Omit<ModelConfig, "provider" | "api" | "baseUrl" | "apiKey" | "apiKeyEnv" | "name" | "cost"> {
  name?: string;
  cost?: ModelConfig["cost"];
}

export interface ConfiguredProvider {
  id: string;
  name: string;
  preset?: string;
  provider: string;
  api: ModelConfig["api"];
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  supportsWebSocket: boolean;
  transport: "http" | "auto";
  models: ConfiguredModel[];
}

export interface ModelDefaults {
  modelRef?: string;
  smallTextModelRef?: string;
  thinkingLevel?: string;
}

export interface ModelConfigDocument {
  version: 1;
  providers: ConfiguredProvider[];
  defaults: ModelDefaults;
}

export const emptyConfig = (): ModelConfigDocument => ({ version: 1, providers: [], defaults: {} });
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidConfig();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key))) invalidConfig();
  return result;
}

function text(value: unknown): string;
function text(value: unknown, optional: true): string | undefined;
function text(value: unknown, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") invalidConfig();
  const trimmed = value.trim();
  if (!trimmed && !optional) invalidConfig();
  return trimmed || undefined;
}

export function resolveKey(
  provider: Pick<ConfiguredProvider, "apiKey" | "apiKeyEnv">,
  env: Readonly<Record<string, string | undefined>>,
) {
  const environment = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
  return environment?.trim() ? environment : provider.apiKey?.trim() ? provider.apiKey : undefined;
}

function runtimeModel(provider: ConfiguredProvider, model: ConfiguredModel, apiKey: string): ResolvedModelConfig {
  return {
    ...model,
    name: model.name?.trim() || model.modelId,
    cost: model.cost === undefined ? zeroCost : model.cost,
    provider: provider.provider,
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKey,
  };
}

export function normalizeConfig(value: unknown): ModelConfigDocument {
  const root = object(value, ["version", "providers", "defaults"]);
  if (root.version !== 1 || !Array.isArray(root.providers)) invalidConfig();
  const ids = new Set<string>();
  const names = new Set<string>();
  const providers = root.providers.map((value) => {
    const item = object(value, [
      "id",
      "name",
      "preset",
      "provider",
      "api",
      "baseUrl",
      "apiKey",
      "apiKeyEnv",
      "supportsWebSocket",
      "transport",
      "models",
    ]);
    const id = text(item.id);
    const name = text(item.name);
    if (ids.has(id) || names.has(name) || !Array.isArray(item.models)) invalidConfig();
    ids.add(id);
    names.add(name);
    if (item.supportsWebSocket !== undefined && typeof item.supportsWebSocket !== "boolean") invalidConfig();
    if (item.transport !== undefined && item.transport !== "http" && item.transport !== "auto") invalidConfig();
    const provider: ConfiguredProvider = {
      id,
      name,
      preset: text(item.preset, true),
      provider: text(item.provider),
      api: text(item.api) as ModelConfig["api"],
      baseUrl: text(item.baseUrl),
      apiKey: text(item.apiKey, true),
      apiKeyEnv: text(item.apiKeyEnv, true),
      supportsWebSocket: item.supportsWebSocket === true,
      transport: item.transport === "auto" ? "auto" : "http",
      models: [],
    };
    if (!provider.apiKey && !provider.apiKeyEnv) invalidConfig();
    // Validate connection fields even when this provider has no models.
    validateModel(
      runtimeModel(
        provider,
        {
          id: "validation",
          modelId: "validation",
          reasoning: false,
          input: ["text"],
          contextWindow: defaultContextWindow,
          maxTokens: defaultMaxTokens,
        },
        "validation",
      ),
    );
    const upstreamIds = new Set<string>();
    provider.models = item.models.map((value) => {
      const model = object(value, [
        "id",
        "modelId",
        "name",
        "input",
        "reasoning",
        "thinkingLevelMap",
        "contextWindow",
        "maxTokens",
        "headers",
        "compat",
        "samplingParams",
        "cost",
      ]);
      const modelId = text(model.modelId);
      const localId = text(model.id);
      if (ids.has(localId) || upstreamIds.has(modelId)) invalidConfig();
      ids.add(localId);
      upstreamIds.add(modelId);
      const candidate = {
        id: localId,
        modelId,
        name: text(model.name, true),
        headers: model.headers,
        compat: model.compat,
        samplingParams: model.samplingParams,
        cost: model.cost,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input === undefined ? ["text"] : model.input,
        reasoning: model.reasoning === undefined ? false : model.reasoning,
        contextWindow: model.contextWindow === undefined ? defaultContextWindow : model.contextWindow,
        maxTokens: model.maxTokens === undefined ? defaultMaxTokens : model.maxTokens,
      } as ConfiguredModel;
      validateModel(runtimeModel(provider, candidate, "validation"));
      const thinking = candidate.reasoning && matchThinkingMap(candidate.thinkingLevelMap);
      candidate.reasoning = Boolean(thinking);
      candidate.thinkingLevelMap = thinking ? { ...thinking.map } : undefined;
      if (candidate.headers) {
        const keys = Object.keys(candidate.headers).map((key) => key.toLowerCase());
        if (new Set(keys).size !== keys.length) invalidConfig();
        try {
          new Headers(candidate.headers);
        } catch {
          invalidConfig();
        }
      }
      return candidate;
    });
    return provider;
  });
  const defaults = object(root.defaults, ["modelRef", "smallTextModelRef", "thinkingLevel"]);
  const result: ModelConfigDocument = {
    version: 1,
    providers,
    defaults: {
      modelRef: text(defaults.modelRef, true),
      smallTextModelRef: text(defaults.smallTextModelRef, true),
      thinkingLevel: text(defaults.thinkingLevel, true),
    },
  };
  const models = providers.flatMap((provider) => provider.models);
  for (const id of [result.defaults.modelRef, result.defaults.smallTextModelRef]) {
    if (id && !models.some((model) => model.id === id)) invalidConfig();
  }
  const selected = models.find((model) => model.id === result.defaults.modelRef);
  if (
    result.defaults.thinkingLevel &&
    (!selected?.reasoning ||
      typeof selected.thinkingLevelMap?.[
        result.defaults.thinkingLevel as keyof NonNullable<ModelConfig["thinkingLevelMap"]>
      ] !== "string")
  )
    invalidConfig();
  return structuredClone(result);
}

export function cleanDefaults(document: ModelConfigDocument) {
  const models = document.providers.flatMap((provider) => provider.models);
  for (const key of ["modelRef", "smallTextModelRef"] as const) {
    if (!models.some((model) => model.id === document.defaults[key])) delete document.defaults[key];
  }
  const model = models.find((model) => model.id === document.defaults.modelRef);
  const level = document.defaults.thinkingLevel as keyof NonNullable<ModelConfig["thinkingLevelMap"]>;
  if (!model?.reasoning || typeof model.thinkingLevelMap?.[level] !== "string") delete document.defaults.thinkingLevel;
}

export function resolveModels(document: ModelConfigDocument, env: Readonly<Record<string, string | undefined>>) {
  const entries = document.providers.flatMap((provider) => {
    const key = resolveKey(provider, env);
    return key ? provider.models.map((model) => runtimeModel(provider, model, key)) : [];
  });
  return [...configureModels(entries).values()];
}

export async function loadConfig(env: Readonly<Record<string, string | undefined>>, defaultPath?: string) {
  const path = env.XIAOWEI_LLM_CONFIG ?? defaultPath;
  if (!path || !isAbsolute(path)) invalidConfig();
  let data: string;
  try {
    data = await readFile(path, "utf8");
  } catch (error) {
    if (!env.XIAOWEI_LLM_CONFIG && (error as NodeJS.ErrnoException).code === "ENOENT")
      return { path, document: emptyConfig() };
    throw new Error("Unable to read LLM configuration");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    invalidConfig();
  }
  return { path, document: normalizeConfig(parsed) };
}

export async function writeConfig(path: string, document: ModelConfigDocument) {
  const normalized = normalizeConfig(document);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
