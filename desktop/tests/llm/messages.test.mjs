import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { FinishReason, GenerateRequestSchema } from "xiaowei-contracts";
import { toContext } from "../../src/main/services/llm/worker/messages.ts";
import { llmFixture, request, waitFor } from "../fixtures/llm.mjs";

const user = (text) => ({
  message: {
    case: "user",
    value: {
      timestampMs: 1n,
      content: [{ content: { case: "text", value: { text } } }],
    },
  },
});
const collect = async (stream) => {
  const events = [];
  for await (const event of stream) events.push(event.event);
  return events;
};
for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
  test(`${api}: thinking and tool deltas preserve final arguments and replayable history`, async (t) => {
    const fixture = await llmFixture(t, undefined, api);
    await fixture.owner.updateModels([{ ...fixture.model, reasoning: true }]);
    const tools = [
      {
        name: "echo",
        description: "Echo text",
        parametersJson: JSON.stringify({
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        }),
      },
    ];
    const events = await collect(
      await fixture.client.generate(
        request("", {
          messages: [user("features")],
          tools,
          options: { reasoning: "low" },
          maxTokens: 2048,
        }),
      ),
    );
    assert.equal(events[0].case, "started");
    const done = events.at(-1).value;
    assert.equal(done.reason, FinishReason.TOOL_USE);
    assert.ok(events.some((event) => event.case === "blockDelta" && event.value.kind === "thinking"));
    const toolStart = events.find(
      (event) => event.case === "blockStarted" && event.value.block.content.case === "toolCall",
    );
    assert.equal(toolStart.value.block.content.value.argumentsJson, undefined);
    const call = done.message.content.find((block) => block.content.case === "toolCall").content.value;
    assert.deepEqual(JSON.parse(call.argumentsJson), { text: "中文参数" });
    const thinking = done.message.content.find((block) => block.content.case === "thinking").content.value;
    if (api !== "openai-completions") assert.ok(thinking.signature.includes("signed-thinking"));
    const replay = request("", {
      messages: [
        user("features"),
        { message: { case: "assistant", value: done.message } },
        {
          message: {
            case: "toolResult",
            value: {
              toolCallId: call.id,
              toolName: call.name,
              timestampMs: 2n,
              content: [{ content: { case: "text", value: { text: "中文参数" } } }],
            },
          },
        },
        user("followup"),
      ],
      tools,
    });
    const next = await collect(await fixture.client.generate(replay));
    assert.equal(next.at(-1).case, "finished");
    assert.ok(JSON.stringify(fixture.requests[1].body).includes("中文参数"));
    if (api !== "openai-completions") assert.ok(JSON.stringify(fixture.requests[1].body).includes("signed-thinking"));
  });
}

test("image input and role validation preserve bytes and reject incompatible history", () => {
  const image = { content: { case: "image", value: { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) } } };
  const message = { message: { case: "user", value: { content: [image], timestampMs: 1n } } };
  const input = create(GenerateRequestSchema, { messages: [message] });
  assert.equal(toContext(input, true).messages[0].content[0].data, "AQID");
  assert.throws(() => toContext(input, false), /does not accept images/);
  assert.throws(() => toContext(create(GenerateRequestSchema, { ...input, userText: "ambiguous" }), true), /exclusive/);
  assert.throws(
    () =>
      toContext(
        create(GenerateRequestSchema, {
          messages: [{ message: { case: "assistant", value: {} } }],
        }),
        true,
      ),
    /source is required/,
  );
});

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
  for (const kind of ["thinking", "tool"]) {
    test(`${api}: cancel during ${kind} aborts upstream HTTP`, async (t) => {
      const fixture = await llmFixture(t, undefined, api);
      const prompt = `features-cancel-${kind}`;
      const stream = await fixture.client.generate(request("", { messages: [user(prompt)] }));
      for await (const chunk of stream) {
        if (chunk.event.case === "blockDelta" && chunk.event.value.kind === (kind === "tool" ? "toolcall" : kind)) {
          await stream.cancel();
          break;
        }
      }
      await waitFor(() => fixture.disconnected.has(prompt));
      const next = await fixture.client.generate(request("正常"));
      let finished = false;
      for await (const chunk of next) finished ||= chunk.event.case === "finished";
      assert.ok(finished);
    });
  }
}
