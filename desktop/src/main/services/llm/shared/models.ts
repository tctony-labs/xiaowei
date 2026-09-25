import { GatewayFailure } from "xiaowei-gateway";
import { compatibilityFields, type ModelCompat } from "./model-compat";

export const modelApis = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "pi-messages",
] as const;

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: (Omit<ModelCost, "tiers"> & { inputTokensAbove: number })[];
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  api: (typeof modelApis)[number];
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
  compat?: ModelCompat;
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
  headers?: Record<string, string>;
  samplingParams?: Record<string, unknown>;
  apiKey?: string;
  apiKeyEnv?: string;
}

export type ResolvedModelConfig = Omit<ModelConfig, "apiKey" | "apiKeyEnv"> & { apiKey: string };

export function invalidConfig(): never {
  throw new GatewayFailure({ code: "INVALID_ARGUMENT", message: "invalid LLM model configuration" });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidConfig();
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalidConfig();
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function cost(value: unknown, tier = false) {
  const item = object(value);
  keys(item, ["input", "output", "cacheRead", "cacheWrite", ...(tier ? ["inputTokensAbove"] : ["tiers"])]);
  for (const key of ["input", "output", "cacheRead", "cacheWrite", ...(tier ? ["inputTokensAbove"] : [])]) {
    if (typeof item[key] !== "number" || !Number.isFinite(item[key]) || item[key] < 0) invalidConfig();
  }
  if (item.tiers !== undefined) {
    if (!Array.isArray(item.tiers)) invalidConfig();
    for (const entry of item.tiers) cost(entry, true);
  }
}

function jsonData(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || ancestors.has(value)) invalidConfig();
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) invalidConfig();
  ancestors.add(value);
  for (const entry of Object.values(value)) jsonData(entry, ancestors);
  ancestors.delete(value);
}

function nestedCompatibility(compat: Record<string, unknown>) {
  if (compat.allowedFallbackModels !== undefined) {
    if (!Array.isArray(compat.allowedFallbackModels)) invalidConfig();
    for (const value of compat.allowedFallbackModels) {
      const fallback = object(value);
      keys(fallback, ["provider", "model", "cost"]);
      if (!text(fallback.provider) || !text(fallback.model)) invalidConfig();
      cost(fallback.cost);
    }
  }

  for (const field of ["chatTemplateKwargs", "chatTemplateArgs"]) {
    if (compat[field] === undefined) continue;
    for (const value of Object.values(object(compat[field]))) {
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) continue;
      const variable = object(value);
      keys(variable, ["$var", "omitWhenOff"]);
      if (!["thinking.enabled", "thinking.effort", "thinking.budget"].includes(variable.$var as string))
        invalidConfig();
      if (variable.omitWhenOff !== undefined && typeof variable.omitWhenOff !== "boolean") invalidConfig();
    }
  }

  for (const field of ["vercelGatewayRouting", "openRouterRouting"]) {
    if (compat[field] === undefined) continue;
    const routing = object(compat[field]);
    if (field === "vercelGatewayRouting") keys(routing, ["only", "order"]);
    else
      keys(routing, [
        "allow_fallbacks",
        "require_parameters",
        "data_collection",
        "zdr",
        "enforce_distillable_text",
        "order",
        "only",
        "ignore",
        "quantizations",
        "sort",
        "max_price",
        "preferred_min_throughput",
        "preferred_max_latency",
      ]);
    for (const name of ["only", "order", "ignore", "quantizations"]) {
      const value = routing[name];
      if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")))
        invalidConfig();
    }
    for (const name of ["allow_fallbacks", "require_parameters", "zdr", "enforce_distillable_text"]) {
      if (routing[name] !== undefined && typeof routing[name] !== "boolean") invalidConfig();
    }
    if (routing.data_collection !== undefined && !["deny", "allow"].includes(routing.data_collection as string))
      invalidConfig();
    if (routing.sort !== undefined && typeof routing.sort !== "string") {
      const sort = object(routing.sort);
      keys(sort, ["by", "partition"]);
      if (sort.by !== undefined && typeof sort.by !== "string") invalidConfig();
      if (sort.partition !== undefined && sort.partition !== null && typeof sort.partition !== "string")
        invalidConfig();
    }
    if (routing.max_price !== undefined) {
      const price = object(routing.max_price);
      keys(price, ["prompt", "completion", "image", "audio", "request"]);
      if (Object.values(price).some((value) => typeof value !== "number" && typeof value !== "string")) invalidConfig();
    }
    for (const name of ["preferred_min_throughput", "preferred_max_latency"]) {
      const value = routing[name];
      if (value === undefined || typeof value === "number") continue;
      const percentiles = object(value);
      keys(percentiles, ["p50", "p75", "p90", "p99"]);
      if (Object.values(percentiles).some((entry) => typeof entry !== "number")) invalidConfig();
    }
  }
}

export function validateModel(value: unknown): asserts value is ModelConfig {
  const item = object(value);
  keys(item, [
    "id",
    "name",
    "provider",
    "modelId",
    "api",
    "baseUrl",
    "reasoning",
    "input",
    "contextWindow",
    "maxTokens",
    "cost",
    "compat",
    "thinkingLevelMap",
    "headers",
    "samplingParams",
    "apiKey",
    "apiKeyEnv",
  ]);
  for (const key of ["id", "name", "provider", "modelId", "baseUrl"]) {
    if (!text(item[key])) invalidConfig();
  }
  if (!modelApis.includes(item.api as ModelConfig["api"])) invalidConfig();
  let url: URL;
  try {
    url = new URL(item.baseUrl as string);
  } catch {
    invalidConfig();
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    invalidConfig();
  for (const key of ["contextWindow", "maxTokens"]) {
    if (!Number.isSafeInteger(item[key]) || (item[key] as number) < 1) invalidConfig();
  }
  if ((item.contextWindow as number) < (item.maxTokens as number) || typeof item.reasoning !== "boolean")
    invalidConfig();
  if (
    !Array.isArray(item.input) ||
    !item.input.includes("text") ||
    item.input.some((entry) => entry !== "text" && entry !== "image")
  )
    invalidConfig();
  cost(item.cost);
  for (const key of ["apiKey", "apiKeyEnv"]) {
    if (item[key] !== undefined && typeof item[key] !== "string") invalidConfig();
  }
  if (item.compat !== undefined) {
    jsonData(item.compat);
    const compat = object(item.compat);
    keys(compat, Object.keys(compatibilityFields));
    nestedCompatibility(compat);
    for (const [key, value] of Object.entries(compat)) {
      const kind = compatibilityFields[key];
      if (Array.isArray(kind)) {
        if (!kind.includes(value as string)) invalidConfig();
      } else if (kind === "array") {
        if (!Array.isArray(value)) invalidConfig();
      } else if (kind === "object") object(value);
      else if (typeof value !== kind || (kind === "number" && !Number.isFinite(value))) invalidConfig();
    }
  }
  for (const field of ["headers", "samplingParams"]) {
    if (item[field] !== undefined) {
      object(item[field]);
      jsonData(item[field]);
    }
  }
  if (item.headers && Object.values(object(item.headers)).some((value) => typeof value !== "string")) invalidConfig();
  if (item.thinkingLevelMap !== undefined) {
    const levels = object(item.thinkingLevelMap);
    keys(levels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    for (const level of Object.values(levels)) {
      if (level !== null && typeof level !== "string") invalidConfig();
    }
  }
}

export function configureModels(configs: readonly ResolvedModelConfig[]) {
  if (!Array.isArray(configs)) invalidConfig();
  const models = new Map<string, ResolvedModelConfig>();
  for (const config of configs) {
    validateModel(config);
    if (!text(config.apiKey) || "apiKeyEnv" in config || models.has(config.id)) invalidConfig();
    models.set(config.id, structuredClone({ ...config, apiKey: config.apiKey }));
  }
  return models;
}
