import type { SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import type { GenerateRequest } from "xiaowei-contracts";
import type { ResolvedModelConfig } from "../shared/models";
import { invalid, json } from "./messages";

export function toOptions(request: GenerateRequest, config: ResolvedModelConfig) {
  if (
    request.temperature !== undefined &&
    (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)
  )
    invalid("temperature must be between 0 and 2");
  if (
    request.maxTokens !== undefined &&
    (!Number.isInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > config.maxTokens)
  )
    invalid("max tokens exceeds configured limit");
  const options = request.options;
  const common: StreamOptions = {
    temperature: request.temperature,
    maxTokens: request.maxTokens ?? config.maxTokens,
    maxRetries: 0,
    samplingParams: config.samplingParams ? structuredClone(config.samplingParams) : undefined,
  };
  if (!options) return { simple: true, options: common as SimpleStreamOptions };
  if (options.cacheRetention !== undefined) {
    if (!["none", "short", "long"].includes(options.cacheRetention)) invalid("invalid cache retention");
    common.cacheRetention = options.cacheRetention as StreamOptions["cacheRetention"];
  }
  if (options.transport !== undefined) {
    if (!["sse", "websocket", "websocket-cached", "auto"].includes(options.transport)) invalid("invalid transport");
    common.transport = options.transport as StreamOptions["transport"];
  }
  common.sessionId = options.sessionId;
  common.timeoutMs = options.timeoutMs;
  common.websocketConnectTimeoutMs = options.websocketConnectTimeoutMs;
  for (const value of [options.timeoutMs, options.websocketConnectTimeoutMs]) {
    if (value !== undefined && value === 0) invalid("timeouts must be positive");
  }
  if (options.samplingParamsJson !== undefined)
    common.samplingParams = {
      ...common.samplingParams,
      ...(json(options.samplingParamsJson, true) as Record<string, unknown>),
    };
  if (options.metadataJson !== undefined) common.metadata = json(options.metadataJson, true) as Record<string, unknown>;
  if (options.apiOptionsJson !== undefined) {
    if (
      options.reasoning !== undefined ||
      options.thinkingBudgetsJson !== undefined ||
      options.toolChoiceJson !== undefined
    )
      invalid("API options and simple reasoning/tool options are exclusive");
    const extra = json(options.apiOptionsJson, true) as Record<string, unknown>;
    const allowed: Record<ResolvedModelConfig["api"], readonly string[]> = {
      "openai-completions": ["toolChoice", "reasoningEffort", "thinkingBudgets"],
      "openai-responses": ["toolChoice", "reasoningEffort", "reasoningSummary", "serviceTier"],
      "openai-codex-responses": ["toolChoice", "reasoningEffort", "reasoningSummary", "serviceTier", "textVerbosity"],
      "azure-openai-responses": [
        "toolChoice",
        "reasoningEffort",
        "reasoningSummary",
        "azureApiVersion",
        "azureResourceName",
        "azureBaseUrl",
        "azureDeploymentName",
      ],
      "anthropic-messages": [
        "toolChoice",
        "thinkingEnabled",
        "thinkingBudgetTokens",
        "effort",
        "thinkingDisplay",
        "interleavedThinking",
      ],
      "bedrock-converse-stream": [
        "toolChoice",
        "reasoning",
        "thinkingBudgets",
        "interleavedThinking",
        "thinkingDisplay",
        "requestMetadata",
      ],
      "google-generative-ai": ["toolChoice", "thinking"],
      "google-vertex": ["toolChoice", "thinking", "project", "location"],
      "mistral-conversations": ["toolChoice", "promptMode", "reasoningEffort"],
      "pi-messages": ["toolChoice", "reasoning", "debug"],
    };
    if (Object.keys(extra).some((key) => !allowed[config.api].includes(key))) invalid("unsupported API option");
    for (const [key, value] of Object.entries(extra)) {
      if (["thinkingEnabled", "interleavedThinking", "debug"].includes(key)) {
        if (typeof value !== "boolean") invalid("invalid API boolean option");
      } else if (key === "thinkingBudgetTokens") {
        if (!Number.isSafeInteger(value) || (value as number) < 1) invalid("invalid thinking budget");
      } else if (["thinking", "thinkingBudgets", "requestMetadata"].includes(key)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) invalid("invalid API object option");
      } else if (key === "toolChoice") {
        if (typeof value !== "string" && (!value || typeof value !== "object" || Array.isArray(value)))
          invalid("invalid tool choice");
      } else if (key === "reasoningSummary" && value === null) {
      } else if (typeof value !== "string") invalid("invalid API string option");
    }
    return { simple: false, options: { ...common, ...extra } };
  }
  const simple: SimpleStreamOptions = common;
  if (options.reasoning !== undefined) {
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(options.reasoning))
      invalid("invalid reasoning level");
    if (options.reasoning !== "off" && !config.reasoning) invalid("model does not support reasoning");
    simple.reasoning =
      options.reasoning === "off" ? undefined : (options.reasoning as SimpleStreamOptions["reasoning"]);
  }
  if (options.thinkingBudgetsJson !== undefined) {
    const budgets = json(options.thinkingBudgetsJson, true) as Record<string, unknown>;
    if (
      Object.entries(budgets).some(
        ([key, value]) =>
          !["minimal", "low", "medium", "high"].includes(key) || !Number.isSafeInteger(value) || (value as number) < 1,
      )
    )
      invalid("invalid thinking budgets");
    simple.thinkingBudgets = budgets;
  }
  if (options.toolChoiceJson !== undefined) {
    const choice = json(options.toolChoiceJson);
    if (choice !== "auto" && choice !== "none") invalid("invalid simple tool choice");
    simple.toolChoice = choice;
  }
  return { simple: true, options: simple };
}
