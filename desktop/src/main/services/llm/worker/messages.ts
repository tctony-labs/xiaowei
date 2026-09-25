import { Buffer } from "node:buffer";
import { create } from "@bufbuild/protobuf";
import type {
  Context,
  JsonObject,
  JsonValue,
  Message,
  AssistantMessage as PiAssistant,
  Tool,
  Usage,
} from "@earendil-works/pi-ai";
import {
  type AssistantMessage,
  AssistantMessageSchema,
  type ContentBlock,
  ContentBlockSchema,
  FinishReason,
  type GenerateRequest,
  type TokenUsage,
  TokenUsageSchema,
} from "xiaowei-contracts";
import { GatewayFailure } from "xiaowei-gateway";

export function invalid(message: string): never {
  throw new GatewayFailure({ code: "INVALID_ARGUMENT", message });
}

export function json(value: string, object = false): JsonValue {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid("invalid JSON option");
  }
  if (object && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) invalid("expected JSON object");
  return parsed;
}

const reasons = {
  stop: FinishReason.STOP,
  length: FinishReason.LENGTH,
  toolUse: FinishReason.TOOL_USE,
  error: FinishReason.ERROR,
  aborted: FinishReason.ABORTED,
} as const;

export function finishReason(value: string) {
  if (!(value in reasons)) throw new GatewayFailure({ code: "HANDLER_ERROR", message: "unsupported finish reason" });
  return reasons[value as keyof typeof reasons];
}

export function encodeUsage(usage: Usage) {
  const token = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new GatewayFailure({ code: "HANDLER_ERROR", message: "invalid provider usage" });
    return BigInt(value);
  };
  return create(TokenUsageSchema, {
    input: token(usage.input),
    output: token(usage.output),
    cacheRead: token(usage.cacheRead),
    cacheWrite: token(usage.cacheWrite),
    total: token(usage.totalTokens),
    reasoning: usage.reasoning === undefined ? undefined : token(usage.reasoning),
    cacheWrite1h: usage.cacheWrite1h === undefined ? undefined : token(usage.cacheWrite1h),
    cost: usage.cost,
  });
}

function decodeUsage(usage?: TokenUsage): Usage {
  if (!usage?.cost) invalid("assistant usage is required");
  const token = (value: bigint) => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) invalid("invalid history usage");
    return result;
  };
  const cost = {
    input: usage.cost.input,
    output: usage.cost.output,
    cacheRead: usage.cost.cacheRead,
    cacheWrite: usage.cost.cacheWrite,
    total: usage.cost.total,
  };
  if (Object.values(cost).some((value) => !Number.isFinite(value) || value < 0)) invalid("invalid history cost");
  return {
    input: token(usage.input),
    output: token(usage.output),
    cacheRead: token(usage.cacheRead),
    cacheWrite: token(usage.cacheWrite),
    totalTokens: token(usage.total),
    cost,
    reasoning: usage.reasoning === undefined ? undefined : token(usage.reasoning),
    cacheWrite1h: usage.cacheWrite1h === undefined ? undefined : token(usage.cacheWrite1h),
  };
}

type PiBlock = PiAssistant["content"][number];
export function encodeBlock(block: PiBlock, starting = false) {
  if (block.type === "text")
    return create(ContentBlockSchema, {
      content: {
        case: "text",
        value: { text: starting ? "" : block.text, signature: starting ? undefined : block.textSignature },
      },
    });
  if (block.type === "thinking")
    return create(ContentBlockSchema, {
      content: {
        case: "thinking",
        value: {
          text: starting && !block.redacted ? "" : block.thinking,
          signature: starting && !block.redacted ? undefined : block.thinkingSignature,
          redacted: block.redacted,
        },
      },
    });
  return create(ContentBlockSchema, {
    content: {
      case: "toolCall",
      value: {
        id: block.id,
        name: block.name,
        argumentsJson: starting ? undefined : JSON.stringify(block.arguments),
        thoughtSignature: block.thoughtSignature,
        namespace: block.namespace,
      },
    },
  });
}

function decodeBlock(block: ContentBlock): PiBlock | { type: "image"; mimeType: string; data: string } {
  const content = block.content;
  switch (content.case) {
    case "text":
      return { type: "text", text: content.value.text, textSignature: content.value.signature };
    case "thinking":
      return {
        type: "thinking",
        thinking: content.value.text,
        thinkingSignature: content.value.signature,
        redacted: content.value.redacted,
      };
    case "image": {
      if (!content.value.mimeType.startsWith("image/") || !content.value.data.length) invalid("invalid image");
      return {
        type: "image",
        mimeType: content.value.mimeType,
        data: Buffer.from(content.value.data).toString("base64"),
      };
    }
    case "toolCall": {
      if (!content.value.id || !content.value.name || content.value.argumentsJson === undefined)
        invalid("incomplete tool call history");
      return {
        type: "toolCall",
        id: content.value.id,
        name: content.value.name,
        arguments: json(content.value.argumentsJson, true) as JsonObject,
        thoughtSignature: content.value.thoughtSignature,
        namespace: content.value.namespace,
      };
    }
    default:
      return invalid("missing content block");
  }
}

export function encodeAssistant(message: PiAssistant) {
  return create(AssistantMessageSchema, {
    content: message.content.map((block) => encodeBlock(block)),
    api: message.api,
    provider: message.provider,
    modelId: message.model,
    usage: encodeUsage(message.usage),
    stopReason: finishReason(message.stopReason),
    timestampMs: BigInt(message.timestamp),
    responseId: message.responseId,
    responseModel: message.responseModel,
    providerThinkingLevel: message.providerThinkingLevel,
    rawStopReason: message.rawStopReason,
    endTurn: message.endTurn,
  });
}

function timestamp(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) invalid("invalid message timestamp");
  return result;
}

function decodeAssistant(message: AssistantMessage): PiAssistant {
  if (!message.api || !message.provider || !message.modelId) invalid("assistant source is required");
  const content = message.content.map(decodeBlock);
  if (content.some((block) => block.type === "image")) invalid("assistant images are unsupported");
  const stopReason = Object.entries(reasons).find(([, value]) => value === message.stopReason)?.[0];
  if (!stopReason) invalid("invalid assistant finish reason");
  return {
    role: "assistant",
    content: content as PiBlock[],
    api: message.api,
    provider: message.provider,
    model: message.modelId,
    usage: decodeUsage(message.usage),
    stopReason: stopReason as PiAssistant["stopReason"],
    timestamp: timestamp(message.timestampMs),
    responseId: message.responseId,
    responseModel: message.responseModel,
    providerThinkingLevel: message.providerThinkingLevel,
    rawStopReason: message.rawStopReason,
    endTurn: message.endTurn,
  };
}

export function toContext(request: GenerateRequest, acceptsImages: boolean): Context {
  if (request.messages.length && request.userText) invalid("messages and user_text are exclusive");
  const messages: Message[] = request.messages.map(({ message }) => {
    if (message.case === "assistant") return decodeAssistant(message.value);
    if (message.case !== "user" && message.case !== "toolResult") invalid("missing message role");
    const content = message.value.content.map(decodeBlock);
    if (!content.length || content.some((block) => block.type !== "text" && block.type !== "image"))
      invalid("invalid user or tool result content");
    if (!acceptsImages && content.some((block) => block.type === "image")) invalid("model does not accept images");
    const input = content as ({ type: "text"; text: string } | { type: "image"; mimeType: string; data: string })[];
    if (message.case === "user")
      return { role: "user", content: input, timestamp: timestamp(message.value.timestampMs) };
    const result = message.value;
    if (!result.toolCallId || !result.toolName) invalid("tool result identity is required");
    return {
      role: "toolResult",
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      content: input,
      isError: result.isError,
      timestamp: timestamp(result.timestampMs),
      details: result.detailsJson === undefined ? undefined : json(result.detailsJson),
      addedToolNames: result.addedToolNames,
      usage: result.usage ? decodeUsage(result.usage) : undefined,
    };
  });
  if (!messages.length) {
    if (!request.userText.trim()) invalid("user text or messages is required");
    messages.push({ role: "user", content: request.userText, timestamp: Date.now() });
  }
  const names = new Set<string>();
  const tools: Tool[] = request.tools.map((tool) => {
    if (!tool.name || names.has(tool.name)) invalid("invalid or duplicate tool name");
    names.add(tool.name);
    const parameters = json(tool.parametersJson, true) as Record<string, unknown>;
    if (parameters.type !== "object") invalid("tool parameters must describe an object");
    const constrained = tool.constrainedSamplingJson === undefined ? undefined : json(tool.constrainedSamplingJson);
    if (constrained !== undefined && constrained !== false) {
      if (!constrained || typeof constrained !== "object" || Array.isArray(constrained))
        invalid("invalid constrained sampling");
      const value = constrained as Record<string, unknown>;
      if (value.type === "json_schema") {
        if (value.strict !== "prefer" && value.strict !== "require") invalid("invalid strict sampling");
      } else if (value.type === "grammar") {
        if (!value.variants || typeof value.variants !== "object" || Array.isArray(value.variants))
          invalid("invalid grammar variants");
        if (
          Object.entries(value.variants).some(
            ([key, grammar]) => !["openai_lark", "openai_regex"].includes(key) || typeof grammar !== "string",
          )
        )
          invalid("invalid grammar variant");
      } else invalid("invalid constrained sampling type");
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: parameters as Tool["parameters"],
      constrainedSampling: constrained as Tool["constrainedSampling"],
    };
  });
  return { systemPrompt: request.systemPrompt || undefined, messages, tools: tools.length ? tools : undefined };
}
