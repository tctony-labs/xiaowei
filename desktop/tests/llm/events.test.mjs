import assert from "node:assert/strict";
import { test } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { GenerateEventSchema, GenerateRequestSchema } from "xiaowei-contracts";
import { mapEvent } from "../../src/main/services/llm/worker/events.ts";
import { toContext } from "../../src/main/services/llm/worker/messages.ts";

const message = {
  role: "assistant",
  api: "anthropic-messages",
  provider: "anthropic",
  model: "test",
  timestamp: 123,
  stopReason: "stop",
  responseId: "response",
  responseModel: "actual",
  usage: {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 10,
    reasoning: 1,
    cacheWrite1h: 4,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  },
  content: [
    { type: "thinking", thinking: "hidden", thinkingSignature: "encrypted", redacted: true },
    { type: "text", text: "answer", textSignature: "signed-text" },
    {
      type: "toolCall",
      id: "call",
      name: "echo",
      arguments: { value: "中文" },
      thoughtSignature: "signed-tool",
      namespace: "fixture",
    },
  ],
};

test("authoritative assistant metadata survives protobuf and history replay", () => {
  const [usage, finished] = mapEvent({ type: "done", reason: "stop", message }, true);
  assert.equal(usage.event.value.reasoning, 1n);
  const decoded = fromBinary(GenerateEventSchema, toBinary(GenerateEventSchema, finished));
  const replay = toContext(
    create(GenerateRequestSchema, {
      messages: [{ message: { case: "assistant", value: decoded.event.value.message } }],
    }),
    true,
  ).messages[0];
  assert.deepEqual(replay.content, message.content);
  assert.equal(replay.responseId, "response");
  assert.equal(replay.responseModel, "actual");
  assert.equal(replay.usage.cacheWrite1h, 4);
});

test("buffered start events never expose accumulated delta content as initial content", () => {
  const [text] = mapEvent({ type: "text_start", contentIndex: 1, partial: message }, true);
  assert.equal(text.event.value.block.content.value.text, "");
  assert.equal(text.event.value.block.content.value.signature, undefined);
  const [thinking] = mapEvent({ type: "thinking_start", contentIndex: 0, partial: message }, true);
  assert.equal(thinking.event.value.block.content.value.signature, "encrypted");
  const [tool] = mapEvent({ type: "toolcall_start", contentIndex: 2, partial: message }, true);
  assert.equal(tool.event.value.block.content.value.argumentsJson, undefined);
});

test("provider failure preserves partial content without raw diagnostic fields", () => {
  const [failed] = mapEvent(
    {
      type: "error",
      reason: "error",
      error: {
        ...message,
        stopReason: "error",
        errorMessage: "secret",
        rawStopReason: "secret",
      },
    },
    true,
  );
  assert.equal(failed.event.case, "failed");
  assert.equal(failed.event.value.partial.content.length, 3);
  assert.ok(
    !JSON.stringify(failed, (_, value) => (typeof value === "bigint" ? String(value) : value)).includes("secret"),
  );
});
