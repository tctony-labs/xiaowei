import { Buffer } from "node:buffer";
import { toBinary } from "@bufbuild/protobuf";
import type { Model } from "@earendil-works/pi-ai";
import { GenerateEventSchema, type GenerateRequest } from "xiaowei-contracts";
import { GatewayFailure } from "xiaowei-gateway";
import type { ResolvedModelConfig } from "../shared/models";
import { apis } from "./apis";
import { mapEvent } from "./events";
import { toContext } from "./messages";
import { toOptions } from "./options";

function invalid(message: string): never {
  throw new GatewayFailure({ code: "INVALID_ARGUMENT", message });
}

export function toPiModel(config: ResolvedModelConfig): Model<ResolvedModelConfig["api"]> {
  return {
    id: config.modelId,
    name: config.name,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning,
    headers: config.headers ? { ...config.headers } : undefined,
    samplingParams: config.samplingParams ? structuredClone(config.samplingParams) : undefined,
    input: [...config.input],
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    cost: structuredClone(config.cost),
    compat: config.compat ? structuredClone(config.compat) : undefined,
    thinkingLevelMap: config.thinkingLevelMap ? { ...config.thinkingLevelMap } : undefined,
  };
}

export function generate(
  request: GenerateRequest,
  models: ReadonlyMap<string, ResolvedModelConfig>,
  signal: AbortSignal,
) {
  const config = models.get(request.modelRef);
  if (!config) invalid("unknown model reference");
  const context = toContext(request, config.input.includes("image"));
  if (Buffer.byteLength(JSON.stringify(context)) > 16 * 1024 * 1024) invalid("context exceeds 16 MiB");
  if (
    !request.messages.length &&
    Buffer.byteLength(request.systemPrompt) + Buffer.byteLength(request.userText) > 256 * 1024
  )
    invalid("prompt exceeds 256 KiB");
  const options = toOptions(request, config);
  return run(config);

  async function* run(config: ResolvedModelConfig) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let events: ReturnType<ReturnType<(typeof apis)[keyof typeof apis]>["stream"]> | undefined;
    try {
      const model = toPiModel(config);
      const api = apis[config.api]();
      const parameters = { ...options.options, apiKey: config.apiKey, signal: controller.signal };
      events = options.simple ? api.streamSimple(model, context, parameters) : api.stream(model, context, parameters);
      let bytes = 0;
      for await (const event of events) {
        if (signal.aborted) throw new GatewayFailure({ code: "CANCELLED", message: "generation cancelled" });
        if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
          bytes += Buffer.byteLength(event.delta);
          if (bytes > 1024 * 1024)
            throw new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: "generated content exceeds 1 MiB" });
        }
        const mapped = mapEvent(event, request.messages.length > 0);
        // Signatures and final tool arguments may arrive without delta events.
        for (const chunk of mapped) {
          if (toBinary(GenerateEventSchema, chunk).byteLength > 1024 * 1024)
            throw new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: "generation event exceeds 1 MiB" });
        }
        for (const chunk of mapped) yield chunk;
        if (event.type === "done" || event.type === "error") return;
      }
      throw new GatewayFailure({ code: "HANDLER_ERROR", message: "generation ended without a terminal event" });
    } finally {
      controller.abort();
      if (events) await events.result();
      signal.removeEventListener("abort", abort);
    }
  }
}
