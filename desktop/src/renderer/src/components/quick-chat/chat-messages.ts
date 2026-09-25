import { create } from "@bufbuild/protobuf";
import {
  type AssistantMessage,
  type ChatMessage,
  ChatMessageSchema,
  FinishReason,
  type GenerateEvent,
} from "xiaowei-contracts";
import type { QuickChatMessage } from "./QuickChatPanel";

export interface ChatEntry extends QuickChatMessage {
  history?: ChatMessage;
}

export function userEntry(text: string): ChatEntry {
  return {
    id: crypto.randomUUID(),
    role: "user",
    text,
    history: create(ChatMessageSchema, {
      message: {
        case: "user",
        value: { content: [{ content: { case: "text", value: { text } } }], timestampMs: BigInt(Date.now()) },
      },
    }),
  };
}

export function assistantContent(message: AssistantMessage) {
  if (message.content.some((block) => block.content.case === "toolCall")) throw new Error("本次对话不支持工具调用。");
  return {
    text: message.content
      .flatMap((block) => (block.content.case === "text" ? [block.content.value.text] : []))
      .join(""),
    thinking: message.content
      .flatMap((block) => (block.content.case === "thinking" ? [block.content.value.text] : []))
      .join(""),
  };
}

// Index-aware accumulation keeps interleaved content ordered; the terminal message is authoritative.
export function replyAccumulator(id: string) {
  const blocks = new Map<number, { text: string; thinking: string }>();
  let reply: ChatEntry = { id, role: "assistant", text: "", status: "generating" };
  let terminal = false;
  return {
    get terminal() {
      return terminal;
    },
    accept({ event }: GenerateEvent): ChatEntry {
      if (terminal) throw new Error("模型返回了重复的结束事件。");
      if (event.case === "finished") {
        if (event.value.reason === FinishReason.TOOL_USE) throw new Error("本次对话不支持工具调用。");
        if (!event.value.message || ![FinishReason.STOP, FinishReason.LENGTH].includes(event.value.reason)) {
          throw new Error("模型没有返回完整回复。");
        }
        reply = {
          ...reply,
          ...assistantContent(event.value.message),
          status: "complete",
          history: create(ChatMessageSchema, { message: { case: "assistant", value: event.value.message } }),
        };
        terminal = true;
      } else if (event.case === "failed") {
        reply = {
          ...reply,
          ...(event.value.partial ? assistantContent(event.value.partial) : {}),
          status: "failed",
          error: "模型请求失败，请稍后重试。",
        };
        terminal = true;
      } else if (event.case === "textDelta" || event.case === "blockDelta") {
        const value = event.value;
        const block = blocks.get(value.contentIndex) ?? { text: "", thinking: "" };
        if (event.case === "textDelta") block.text += event.value.text;
        else if (event.value.kind === "thinking") block.thinking += event.value.delta;
        else throw new Error("本次对话不支持工具调用。");
        blocks.set(value.contentIndex, block);
      } else if (event.case === "blockStarted" || event.case === "blockFinished") {
        const content = event.value.block?.content;
        if (content?.case === "toolCall") throw new Error("本次对话不支持工具调用。");
        if (event.case === "blockFinished" && content) {
          const block = blocks.get(event.value.contentIndex) ?? { text: "", thinking: "" };
          if (content.case === "text") block.text = content.value.text;
          if (content.case === "thinking") block.thinking = content.value.text;
          blocks.set(event.value.contentIndex, block);
        }
      }
      if (!terminal) {
        const ordered = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
        reply = {
          ...reply,
          text: ordered.map((block) => block.text).join(""),
          thinking: ordered.map((b) => b.thinking).join(""),
        };
      }
      return reply;
    },
  };
}
