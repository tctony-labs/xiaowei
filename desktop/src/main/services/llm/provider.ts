import { Buffer } from "node:buffer";
import { create } from "@bufbuild/protobuf";
import type { Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { FinishReason, GenerateEventSchema, type GenerateRequest } from "xiaowei-contracts";
import { GatewayFailure } from "xiaowei-gateway";

/** Supplied by the host, never accepted as a Gateway request or renderer payload. */
export interface ModelConfig {
  ref: string;
  id: string;
  baseUrl: string;
  apiKey: string;
  maxTokens: number;
  contextWindow: number;
}

function invalid(message: string): never {
  throw new GatewayFailure({ code: "INVALID_ARGUMENT", message });
}

export function configureModels(configs: readonly ModelConfig[]) {
  const models = new Map<string, ModelConfig>();
  for (const config of configs) {
    const url = new URL(config.baseUrl);
    if (
      !config.ref ||
      !config.id ||
      !config.apiKey ||
      models.has(config.ref) ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !Number.isSafeInteger(config.maxTokens) ||
      config.maxTokens < 1 ||
      !Number.isSafeInteger(config.contextWindow) ||
      config.contextWindow < config.maxTokens
    )
      invalid("invalid LLM host configuration");
    models.set(config.ref, Object.freeze({ ...config }));
  }
  return models;
}

export function generate(request: GenerateRequest, models: ReadonlyMap<string, ModelConfig>, signal: AbortSignal) {
  const config = models.get(request.modelRef);
  if (!config) invalid("unknown model reference");
  if (!request.userText.trim()) invalid("user text is required");
  if (Buffer.byteLength(request.systemPrompt) + Buffer.byteLength(request.userText) > 256 * 1024)
    invalid("prompt exceeds 256 KiB");
  if (
    request.temperature !== undefined &&
    (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)
  )
    invalid("temperature must be between 0 and 2");
  const maxTokens = request.maxTokens ?? Math.min(1024, config.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > Math.min(4096, config.maxTokens))
    invalid("max tokens exceeds configured limit");

  return run(config);

  async function* run(config: ModelConfig) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const model: Model<"openai-completions"> = {
      id: config.id,
      name: config.id,
      api: "openai-completions",
      provider: "openai",
      baseUrl: config.baseUrl,
      reasoning: false,
      input: ["text"],
      contextWindow: config.contextWindow,
      maxTokens: config.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsFinishReason: true, maxTokensField: "max_tokens" },
    };
    const events = stream(
      model,
      {
        systemPrompt: request.systemPrompt || undefined,
        messages: [{ role: "user", content: request.userText, timestamp: Date.now() }],
      },
      {
        apiKey: config.apiKey,
        temperature: request.temperature,
        maxTokens,
        maxRetries: 0,
        signal: controller.signal,
      },
    );
    let bytes = 0;
    try {
      for await (const event of events) {
        if (signal.aborted) throw new GatewayFailure({ code: "CANCELLED", message: "generation cancelled" });
        if (event.type === "text_delta") {
          bytes += Buffer.byteLength(event.delta);
          if (bytes > 1024 * 1024)
            throw new GatewayFailure({ code: "RESOURCE_EXHAUSTED", message: "generated text exceeds 1 MiB" });
          yield create(GenerateEventSchema, {
            event: { case: "textDelta", value: { contentIndex: event.contentIndex, text: event.delta } },
          });
        } else if (event.type === "done") {
          if (event.reason !== "stop" && event.reason !== "length")
            throw new GatewayFailure({ code: "HANDLER_ERROR", message: "unsupported generation finish reason" });
          const usage = event.message.usage;
          const token = (value: number) => {
            if (!Number.isSafeInteger(value) || value < 0)
              throw new GatewayFailure({ code: "HANDLER_ERROR", message: "invalid provider usage" });
            return BigInt(value);
          };
          yield create(GenerateEventSchema, {
            event: {
              case: "usage",
              value: {
                input: token(usage.input),
                output: token(usage.output),
                cacheRead: token(usage.cacheRead),
                cacheWrite: token(usage.cacheWrite),
                total: token(usage.totalTokens),
              },
            },
          });
          if (signal.aborted) return;
          yield create(GenerateEventSchema, {
            event: {
              case: "finished",
              value: {
                reason: event.reason === "stop" ? FinishReason.STOP : FinishReason.LENGTH,
              },
            },
          });
          return;
        } else if (event.type === "error") {
          // Provider diagnostics can contain credentials or response bodies; never relay them verbatim.
          yield create(GenerateEventSchema, {
            event: { case: "failed", value: { message: "model generation failed" } },
          });
          return;
        } else if (event.type.startsWith("thinking_") || event.type.startsWith("toolcall_")) {
          throw new GatewayFailure({ code: "HANDLER_ERROR", message: "only text generation is supported" });
        }
      }
      throw new GatewayFailure({ code: "HANDLER_ERROR", message: "generation ended without a terminal event" });
    } finally {
      controller.abort();
      await events.result();
      signal.removeEventListener("abort", abort);
    }
  }
}
