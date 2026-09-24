import assert from "node:assert/strict";
import { test } from "node:test";
import { FinishReason } from "xiaowei-contracts";
import { llmFixture, request, waitFor } from "../fixtures/llm.mjs";

const code = (expected) => (error) => error.detail?.code === expected;

test("built LLM worker maps requests, text, usage and unique terminal", async (t) => {
  const fixture = await llmFixture(t);
  for (const [text, reason] of [
    ["正常", FinishReason.STOP],
    ["length", FinishReason.LENGTH],
  ]) {
    const stream = await fixture.client.generate(request(text));
    const events = [];
    for await (const chunk of stream) events.push(chunk.event);
    assert.deepEqual(
      events.map((event) => event.case),
      ["textDelta", "textDelta", "usage", "finished"],
    );
    assert.deepEqual(
      events.slice(0, 2).map((event) => [event.value.contentIndex, event.value.text]),
      [
        [0, "你"],
        [0, "好"],
      ],
    );
    assert.equal(events[2].value.input, 5n);
    assert.equal(events[2].value.cacheRead, 3n);
    assert.equal(events[2].value.output, 2n);
    assert.equal(events[2].value.total, 10n);
    assert.equal(events[3].value.reason, reason);
  }
  const defaults = await fixture.client.generate(request("defaults", { temperature: undefined, maxTokens: undefined }));
  for await (const _chunk of defaults) {
    // Complete the request before inspecting the captured provider body.
  }
  assert.equal(fixture.requests[2].body.max_tokens, 1024);
  assert.equal(fixture.requests[2].body.temperature, undefined);
  const first = fixture.requests[0];
  assert.equal(first.path, "/chat/completions");
  assert.equal(first.auth, "Bearer test-key");
  assert.equal(first.body.model, "text-model");
  assert.equal(first.body.temperature, 0.4);
  assert.equal(first.body.max_tokens, 128);
  assert.deepEqual(first.body.messages, [
    { role: "system", content: "系统提示" },
    { role: "user", content: "正常" },
  ]);
});

test("LLM rejects unsupported inputs before HTTP and propagates sanitized failures", async (t) => {
  const fixture = await llmFixture(t);
  for (const extra of [
    { modelRef: "missing" },
    { temperature: NaN },
    { temperature: 3 },
    { maxTokens: 0 },
    { maxTokens: 4097 },
    { userText: " " },
    { systemPrompt: "x".repeat(256 * 1024) },
  ]) {
    await assert.rejects(fixture.client.generate(request("正常", extra)), code("INVALID_ARGUMENT"));
  }
  assert.equal(fixture.requests.length, 0);
  for (const text of ["http-error", "truncated"]) {
    const stream = await fixture.client.generate(request(text));
    const received = [];
    for await (const chunk of stream) received.push(chunk.event);
    assert.equal(received.at(-1).case, "failed");
    assert.equal(received.filter((event) => event.case === "failed").length, 1);
    assert.ok(!received.some((event) => event.case === "finished"));
    assert.ok(!received.at(-1).value.message.includes("test-key"));
  }
  for (const text of ["reasoning", "tool", "overflow"]) {
    const stream = await fixture.client.generate(request(text));
    const received = [];
    await assert.rejects(
      async () => {
        for await (const chunk of stream) received.push(chunk.event.case);
      },
      code(text === "overflow" ? "RESOURCE_EXHAUSTED" : "HANDLER_ERROR"),
    );
    assert.ok(!received.includes("finished"));
  }
  assert.equal(fixture.requests.length, 5);
});

test("LLM cancellation and owner close abort HTTP, including a paused consumer", async (t) => {
  const fixture = await llmFixture(t);
  for (const text of ["cancel", "slow"]) {
    const stream = await fixture.client.generate(request(text));
    assert.equal((await stream.next()).value.event.value.text, "你");
    const pending = text === "cancel" ? assert.rejects(stream.next(), code("CANCELLED")) : undefined;
    await stream.cancel();
    await pending;
    await waitFor(() => fixture.disconnected.has(text));
    await assert.rejects(stream.next(), code("CANCELLED"));
  }
  const stream = await fixture.client.generate(request("close"));
  await stream.next();
  const pending = assert.rejects(stream.next(), code("OWNER_UNAVAILABLE"));
  await fixture.owner.close();
  await pending;
  await waitFor(() => fixture.disconnected.has("close"));
});
