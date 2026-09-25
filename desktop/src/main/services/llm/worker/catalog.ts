import { create } from "@bufbuild/protobuf";
import { type ListModelsRequest, ListModelsResponseSchema, ModelInput } from "xiaowei-contracts";
import { GatewayFailure } from "xiaowei-gateway";
import { thinkingLevels } from "../../../../shared/llm-models";
import type { ResolvedModelConfig } from "../shared/models";
import { invalid } from "./messages";

export async function* listModels(
  request: ListModelsRequest,
  models: ReadonlyMap<string, ResolvedModelConfig>,
  signal: AbortSignal,
) {
  if (Boolean(request.modelRef) === Boolean(request.connection)) invalid("provide model reference or connection");
  const model = request.connection ?? models.get(request.modelRef);
  if (!model) invalid("unknown model reference");
  let baseUrl: URL;
  try {
    baseUrl = new URL(model.baseUrl);
  } catch {
    return invalid("invalid catalog connection");
  }
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    !model.apiKey.trim()
  )
    invalid("invalid catalog connection");
  const deepseek = baseUrl.hostname === "api.deepseek.com";
  const openaiCompatible = [
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "mistral-conversations",
  ].includes(model.api);
  const format =
    request.format ??
    (deepseek || openaiCompatible ? "openai" : model.api === "anthropic-messages" ? "anthropic" : undefined);
  if (format !== "openai" && format !== "anthropic") invalid("unsupported catalog format");
  let url: URL;
  try {
    const base = model.baseUrl.replace(/\/$/, "");
    const defaultUrl = deepseek
      ? "https://api.deepseek.com/models"
      : `${base}${format === "anthropic" && !base.endsWith("/v1") ? "/v1" : ""}/models`;
    url = new URL(request.url ?? defaultUrl);
  } catch {
    invalid("invalid catalog URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    invalid("invalid catalog URL");
  const origin = url.origin;
  const visited = new Set<string>();
  const seen = new Set<string>();
  while (true) {
    if (visited.has(url.href)) throw new GatewayFailure({ code: "HANDLER_ERROR", message: "catalog pagination loop" });
    visited.add(url.href);
    let page: Record<string, unknown>;
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "error",
        signal,
        headers:
          format === "anthropic"
            ? {
                "x-api-key": model.apiKey,
                "anthropic-version": "2023-06-01",
                ...model.headers,
              }
            : { Authorization: `Bearer ${model.apiKey}`, ...model.headers },
      });
      if (!response.ok) throw new Error("catalog HTTP failure");
      page = (await response.json()) as Record<string, unknown>;
      if (!page || !Array.isArray(page.data)) throw new Error("invalid catalog response");
    } catch {
      throw new GatewayFailure({
        code: signal.aborted ? "CANCELLED" : "HANDLER_ERROR",
        message: signal.aborted ? "catalog cancelled" : "model catalog request failed",
      });
    }
    const entries = (page.data as Record<string, unknown>[])
      .map((entry) => {
        if (!entry || typeof entry.id !== "string" || !entry.id)
          throw new GatewayFailure({ code: "HANDLER_ERROR", message: "invalid catalog model" });
        const optionalLimit = (value: unknown) =>
          typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
        const mapping = entry.thinking_level_map;
        const validMapping =
          mapping &&
          typeof mapping === "object" &&
          !Array.isArray(mapping) &&
          Object.entries(mapping).every(
            ([key, value]) =>
              thinkingLevels.includes(key as (typeof thinkingLevels)[number]) &&
              (value === null || typeof value === "string"),
          );
        return {
          reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : undefined,
          thinkingLevelMapJson: validMapping ? JSON.stringify(mapping) : undefined,
          modelId: entry.id,
          name:
            typeof entry.display_name === "string"
              ? entry.display_name
              : typeof entry.name === "string"
                ? entry.name
                : entry.id,
          contextWindow: optionalLimit(entry.context_window),
          maxTokens: optionalLimit(entry.max_output_tokens),
          input: Array.isArray(entry.input_modalities)
            ? entry.input_modalities.flatMap((input) =>
                input === "text" ? [ModelInput.TEXT] : input === "image" ? [ModelInput.IMAGE] : [],
              )
            : [],
        };
      })
      .filter((entry) => {
        if (seen.has(entry.modelId)) return false;
        seen.add(entry.modelId);
        return true;
      });
    yield create(ListModelsResponseSchema, { models: entries });
    if (signal.aborted) return;
    if (typeof page.next === "string" && page.next) {
      const next = new URL(page.next, url);
      if (next.origin !== origin)
        throw new GatewayFailure({ code: "HANDLER_ERROR", message: "invalid catalog next URL" });
      url = next;
    } else if (page.has_more === true) {
      if (typeof page.last_id !== "string" || !page.last_id)
        throw new GatewayFailure({ code: "HANDLER_ERROR", message: "missing catalog cursor" });
      url.searchParams.set("after_id", page.last_id);
    } else return;
  }
}
