import { create } from "@bufbuild/protobuf";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { GenerateEventSchema } from "xiaowei-contracts";
import { encodeAssistant, encodeBlock, encodeUsage, finishReason } from "./messages";

export function mapEvent(event: AssistantMessageEvent, full: boolean) {
  const emit = (value: Parameters<typeof create<typeof GenerateEventSchema>>[1]) => create(GenerateEventSchema, value);
  if (event.type === "text_delta")
    return [
      emit({
        event: {
          case: "textDelta",
          value: {
            contentIndex: event.contentIndex,
            text: event.delta,
          },
        },
      }),
    ];
  if (event.type === "thinking_delta" || event.type === "toolcall_delta")
    return [
      emit({
        event: {
          case: "blockDelta",
          value: {
            contentIndex: event.contentIndex,
            kind: event.type === "thinking_delta" ? "thinking" : "toolcall",
            delta: event.delta,
          },
        },
      }),
    ];
  if (event.type === "start") return full ? [emit({ event: { case: "started", value: {} } })] : [];
  if (event.type === "done")
    return [
      emit({ event: { case: "usage", value: encodeUsage(event.message.usage) } }),
      emit({
        event: {
          case: "finished",
          value: {
            reason: finishReason(event.reason),
            message: encodeAssistant(event.message),
          },
        },
      }),
    ];
  if (event.type === "error")
    return [
      emit({
        event: {
          case: "failed",
          value: {
            message: event.reason === "aborted" ? "model generation aborted" : "model generation failed",
            partial: encodeAssistant({ ...event.error, rawStopReason: undefined }),
          },
        },
      }),
    ];
  if (event.type === "text_start" || event.type === "text_end") {
    if (!full) return [];
  }
  const starting = event.type.endsWith("_start");
  return [
    emit({
      event: {
        case: starting ? "blockStarted" : "blockFinished",
        value: {
          contentIndex: event.contentIndex,
          block: encodeBlock(event.partial.content[event.contentIndex], starting),
        },
      },
    }),
  ];
}
