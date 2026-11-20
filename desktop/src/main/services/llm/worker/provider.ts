import { Buffer } from "node:buffer";
import { create, toBinary } from "@bufbuild/protobuf";
import { type Context, type Model, normalizeContext } from "@earendil-works/pi-ai";
import { GenerateEventSchema, type GenerateRequest } from "proto-desktop-ts";
import { GatewayFailure } from "xiaowei-gateway";
import type {
  AnthropicMessagesCompat,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
} from "../shared/model-compat";
import type { ResolvedModelConfig } from "../shared/models";
import { apis } from "./apis";
import { generationDiagnostic } from "./diagnostics";
import { mapEvent } from "./events";
import { toContext } from "./messages";
import { toOptions } from "./options";
import { observableSseApis, observeSseFetch } from "./sse-observer";

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
  if (Buffer.byteLength(JSON.stringify(context)) > 16 * 1024 * 1024)
    invalid("context exceeds 16 MiB");
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
    let httpStatus: number | undefined;
    let failureLogged = false;

    function logFailure(error: unknown) {
      if (failureLogged || signal.aborted) return;
      failureLogged = true;
      console.warn("LLM generation failed", {
        session: request.options?.sessionId,
        model: config.id,
        api: config.api,
        ...generationDiagnostic(error, config.api, httpStatus),
      });
    }

    try {
      const model = toPiModel(config);
      const toolChoice = "toolChoice" in options.options ? options.options.toolChoice : undefined;
      const ordered = request.messages.some(({ message }) => message.case === "systemContext");
      const { transcript, allowedTools } = prepareTranscript(
        config,
        model,
        context,
        ordered,
        toolChoice,
      );

      const api = apis[config.api]();
      let firstSseAt: number | undefined;
      let firstSseEmitted = false;
      const parameters = {
        ...options.options,
        apiKey: config.apiKey,
        signal: controller.signal,
        ...(allowedTools && {
          onPayload(payload: unknown) {
            return restrictTools(
              payload as OpenAiToolPayload,
              allowedTools,
              config.api === "openai-completions",
            );
          },
        }),
        onResponse: ({ status }: { status: number }) => {
          httpStatus = status;
        },
        ...(observableSseApis.has(config.api)
          ? {
              fetch: observeSseFetch(
                (receivedAtMs) => {
                  firstSseAt ??= receivedAtMs;
                },
                (status) => {
                  httpStatus = status;
                },
              ),
            }
          : {}),
      };
      if (allowedTools) {
        console.debug("LLM tool availability applied", {
          session: request.options?.sessionId,
          api: config.api,
          allowed: allowedTools.length,
        });
      }
      events = options.simple
        ? api.streamSimple(model, transcript, parameters)
        : api.stream(model, transcript, parameters);
      let bytes = 0;
      for await (const event of events) {
        if (signal.aborted)
          throw new GatewayFailure({ code: "CANCELLED", message: "generation cancelled" });
        if (
          event.type === "text_delta" ||
          event.type === "thinking_delta" ||
          event.type === "toolcall_delta"
        ) {
          bytes += Buffer.byteLength(event.delta);
          if (bytes > 1024 * 1024)
            throw new GatewayFailure({
              code: "RESOURCE_EXHAUSTED",
              message: "generated content exceeds 1 MiB",
            });
        }
        if (firstSseAt !== undefined && !firstSseEmitted) {
          firstSseEmitted = true;
          yield create(GenerateEventSchema, {
            event: { case: "firstSseReceived", value: { receivedAtMs: BigInt(firstSseAt) } },
          });
        }
        if (event.type === "error" && event.reason !== "aborted")
          logFailure(event.error.errorMessage);

        const mapped = mapEvent(event, request.messages.length > 0);
        // Signatures and final tool arguments may arrive without delta events.
        for (const chunk of mapped) {
          if (toBinary(GenerateEventSchema, chunk).byteLength > 1024 * 1024)
            throw new GatewayFailure({
              code: "RESOURCE_EXHAUSTED",
              message: "generation event exceeds 1 MiB",
            });
        }
        for (const chunk of mapped) yield chunk;
        if (event.type === "done" || event.type === "error") return;
      }
      throw new GatewayFailure({
        code: "HANDLER_ERROR",
        message: "generation ended without a terminal event",
      });
    } catch (error) {
      logFailure(error);
      throw error;
    } finally {
      controller.abort();
      if (events) await events.result();
      signal.removeEventListener("abort", abort);
    }
  }
}

function prepareTranscript(
  config: ResolvedModelConfig,
  model: Model<ResolvedModelConfig["api"]>,
  context: Context,
  ordered: boolean,
  toolChoice: unknown,
) {
  const transcript = normalizeContext(context);
  if (!ordered) return { transcript };

  let supportsAllowedTools = false;
  let stripRemovals = false;
  if (config.api === "openai-responses") {
    const compat = config.compat as OpenAIResponsesCompat | undefined;
    const supportsAdditionalTools = compat?.supportsAdditionalTools ?? true;
    model.compat = {
      ...model.compat,
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools,
    };
    supportsAllowedTools = compat?.supportsAllowedTools ?? supportsAdditionalTools;
    // Responses can keep Pi's ordered removal notice without rewriting tool definitions.
    stripRemovals = !supportsAdditionalTools;
  } else if (config.api === "openai-completions") {
    const compat = config.compat as OpenAICompletionsCompat | undefined;
    model.compat = {
      ...model.compat,
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolAdditions: compat?.deferredToolsMode === "kimi",
    };
    supportsAllowedTools =
      compat?.supportsAllowedTools ?? new URL(config.baseUrl).hostname === "api.openai.com";
    stripRemovals = true;
  } else if (config.api === "anthropic-messages") {
    const compat = config.compat as AnthropicMessagesCompat | undefined;
    if (compat?.supportsMidConvoToolChanges) {
      model.compat = { ...model.compat, supportsMidConvoSystemMessages: true };
    }
  }

  // Preserve an explicit caller policy by putting only active tools in the request in that case.
  const useAllowlist = supportsAllowedTools && (toolChoice === undefined || toolChoice === "auto");
  const disabledTools = new Set<string>();
  const activeTools = new Set<string>();
  const messages: Context["messages"] = [];
  const pending: Context["messages"] = [];

  for (const [index, message] of transcript.messages.entries()) {
    if (message.role === "system") {
      for (const tool of message.toolsRemoved ?? []) {
        disabledTools.add(tool.name);
        activeTools.delete(tool.name);
      }
      for (const tool of message.toolsAdded ?? []) {
        disabledTools.delete(tool.name);
        activeTools.add(tool.name);
      }

      const update =
        useAllowlist && stripRemovals ? { ...message, toolsRemoved: undefined } : message;
      if (index === 0) {
        messages.push(update);
      } else if (
        update.toolsRemoved?.length ||
        update.toolsAdded?.length ||
        update.content.length ||
        Object.keys(update.sections ?? {}).length
      ) {
        pending.push(update);
      }
      continue;
    }

    if (message.role === "user") {
      messages.push(message, ...pending.splice(0));
    } else if (message.role === "toolResult") {
      messages.push(message);
      if (transcript.messages[index + 1]?.role !== "toolResult") {
        messages.push(...pending.splice(0));
      }
    } else {
      messages.push(...pending.splice(0), message);
    }
  }
  messages.push(...pending);
  if (config.api === "openai-responses" && disabledTools.size && !useAllowlist) {
    model.compat = { ...model.compat, supportsAdditionalTools: false, supportsToolSearch: false };
  }
  return {
    transcript: { ...transcript, messages },
    allowedTools: useAllowlist && disabledTools.size ? [...activeTools].sort() : undefined,
  };
}

type OpenAiTool = {
  type: "function" | "custom";
  name?: string;
  function?: { name: string };
  custom?: { name: string };
};

type OpenAiToolPayload = {
  tools?: OpenAiTool[];
  input?: { type?: string; tools?: OpenAiTool[] }[];
};

function restrictTools(payload: OpenAiToolPayload, allowed: string[], chatCompletions: boolean) {
  if (!allowed.length) return { ...payload, tool_choice: "none" };

  const types = new Map<string, OpenAiTool["type"]>();
  const declarations = [
    ...(payload.tools ?? []),
    ...(payload.input ?? []).flatMap((item) =>
      item.type === "additional_tools" ? (item.tools ?? []) : [],
    ),
  ];
  for (const tool of declarations) {
    const name = tool.name ?? tool.function?.name ?? tool.custom?.name;
    if (name) types.set(name, tool.type);
  }
  const tools = allowed.map((name) => {
    const type = types.get(name) ?? "function";
    return chatCompletions ? { type, [type]: { name } } : { type, name };
  });
  const choice = { mode: "auto", tools };
  return {
    ...payload,
    tool_choice: chatCompletions
      ? { type: "allowed_tools", allowed_tools: choice }
      : { type: "allowed_tools", ...choice },
  };
}
