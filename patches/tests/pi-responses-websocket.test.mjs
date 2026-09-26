import assert from "node:assert/strict";
import { test } from "node:test";
import { textEvents, until, websocketFixture } from "./fixtures/websocket.mjs";

const consumer = new URL("../../desktop/package.json", import.meta.url).href;
const { stream, streamSimple } = await import(
  import.meta.resolve("@earendil-works/pi-ai/api/openai-responses", consumer)
);
const { cleanupSessionResources, normalizeContext } = await import(
  import.meta.resolve("@earendil-works/pi-ai", consumer)
);
const model = (baseUrl) => ({
  id: "model",
  name: "Model",
  provider: "openai",
  api: "openai-responses",
  baseUrl,
  reasoning: true,
  input: ["text"],
  contextWindow: 16384,
  maxTokens: 1024,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
});
const user = (text) => ({ role: "user", content: text, timestamp: 0 });
const base = { apiKey: "fixture-key", sessionId: "session", transport: "auto", maxRetries: 0, timeoutMs: 1000 };

async function run(fixture, messages, options = {}, extra = {}) {
  const events = stream(model(fixture.baseUrl), normalizeContext({ messages, ...extra }), { ...base, ...options });
  const received = [];
  for await (const event of events) received.push(structuredClone(event));
  return { output: await events.result(), events: received };
}

function cleanup(t) {
  t.after(() => cleanupSessionResources());
}

test("Responses reuses API Key connections and sends exact deltas without changing protocol or sampling", async (t) => {
  const fixture = await websocketFixture(t, { message: ({ send }) => textEvents().forEach(send) });
  cleanup(t);
  const extra = { systemPrompt: "system" };
  const options = { cacheRetention: "none", temperature: 0.4, maxTokens: 128, samplingParams: { top_p: 0.8 } };
  const first = await run(fixture, [user("first")], options, extra);
  assert.equal(first.output.stopReason, "stop");
  assert.equal(first.output.api, "openai-responses");
  const second = await run(fixture, [user("first"), first.output, user("next")], options, extra);
  assert.equal(second.output.stopReason, "stop");
  assert.equal(second.output.usage.totalTokens, 7);
  assert.equal(fixture.connections, 1);
  const [a, b] = fixture.frames.map((frame) => frame.body);
  assert.equal(a.type, "response.create");
  assert.equal(a.stream, undefined);
  assert.equal(a.max_output_tokens, 128);
  assert.equal(a.temperature, 0.4);
  assert.equal(a.top_p, 0.8);
  assert.equal(a.store, false);
  assert.equal(a.prompt_cache_key, undefined);
  assert.equal(b.previous_response_id, "resp_test");
  assert.equal(b.input.length, 1);
  assert.equal(fixture.requests[0].url, "/v1/responses");
  assert.equal(fixture.requests[0].headers.authorization, "Bearer fixture-key");
  assert.equal(fixture.requests[0].headers["chatgpt-account-id"], undefined);
  await run(fixture, [user("edited")], options, extra);
  await run(fixture, [user("first"), first.output, user("next")], { ...options, temperature: 0.7 }, extra);
  assert.equal(fixture.frames[2].body.previous_response_id, undefined);
  assert.equal(fixture.frames[3].body.previous_response_id, undefined);
});

test("endpoint, credentials and headers isolate connections, including concurrent first handshakes", async (t) => {
  const setup = { message: ({ send }) => textEvents().forEach(send) };
  const first = await websocketFixture(t, setup);
  const second = await websocketFixture(t, setup);
  cleanup(t);
  await Promise.all([run(first, [user("one")]), run(first, [user("two")])]);
  assert.equal(first.connections, 2);
  await until(() => first.closed === 1);
  await run(first, [user("three")]);
  assert.equal(first.connections, 2);
  await run(first, [user("other key")], { apiKey: "new-key" });
  await run(first, [user("other headers")], { headers: { "x-route": "other" } });
  await run(second, [user("other endpoint")]);
  assert.equal(first.connections, 4);
  assert.equal(second.connections, 1);
  cleanupSessionResources();
  await until(() => first.closed === 4 && second.closed === 1);
});

test("auto falls back only before sending; explicit WebSocket and cancellation do not fall back", async (t) => {
  const fixture = await websocketFixture(t, {
    upgrade: (_request, socket) => {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return false;
    },
    http: (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        textEvents()
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      );
    },
  });
  cleanup(t);
  assert.equal((await run(fixture, [user("auto")])).output.stopReason, "stop");
  assert.equal((await run(fixture, [user("strict")], { transport: "websocket" })).output.stopReason, "error");
  const controller = new AbortController();
  controller.abort();
  assert.equal((await run(fixture, [user("abort")], { signal: controller.signal })).output.stopReason, "aborted");
  assert.equal(fixture.requests.filter((request) => request.method === "POST").length, 1);
});

for (const started of [false, true]) {
  test(`disconnect after send (${started ? "after" : "before"} first event) never silently replays`, async (t) => {
    const fixture = await websocketFixture(t, {
      message: ({ send, socket }) => {
        if (started) send(textEvents()[0]);
        socket.end();
      },
    });
    cleanup(t);
    const result = await run(fixture, [user("disconnect")]);
    assert.equal(result.output.stopReason, "error");
    assert.equal(fixture.frames.length, 1);
    assert.equal(fixture.requests.filter((request) => request.method === "POST").length, 0);
  });
}

test("rejected continuation reconnects once with full input before any output", async (t) => {
  let count = 0;
  const fixture = await websocketFixture(t, {
    message: ({ send, body }) => {
      count++;
      if (body.previous_response_id) send({ type: "error", code: "previous_response_not_found" });
      else textEvents(`resp_${count}`).forEach(send);
    },
  });
  cleanup(t);
  const first = await run(fixture, [user("first")]);
  const next = await run(fixture, [user("first"), first.output, user("next")]);
  assert.equal(next.output.stopReason, "stop");
  assert.equal(fixture.connections, 2);
  assert.equal(fixture.frames.length, 3);
  assert.equal(fixture.frames[1].body.previous_response_id, "resp_1");
  assert.equal(fixture.frames[2].body.previous_response_id, undefined);
  assert.equal(fixture.frames[2].body.input.length, 3);
  assert.equal(next.events.filter((event) => event.type === "start").length, 1);
});

test("continuation error after response.created fails without retry; cancellation discards the connection", async (t) => {
  const fixture = await websocketFixture(t, {
    message: ({ send, body }) => {
      send(textEvents()[0]);
      if (body.input[0].content[0].text === "error") send({ type: "error", code: "previous_response_not_found" });
    },
  });
  cleanup(t);
  assert.equal((await run(fixture, [user("error")])).output.stopReason, "error");
  assert.equal(fixture.frames.length, 1);
  const controller = new AbortController();
  const pending = run(fixture, [user("cancel")], { signal: controller.signal });
  await until(() => fixture.frames.length === 2);
  controller.abort();
  assert.equal((await pending).output.stopReason, "aborted");
  await until(() => fixture.closed === 2);
});

test("simple options preserve WebSocket selection and successful per-request abort does not close the pooled socket", async (t) => {
  const fixture = await websocketFixture(t, { message: ({ send }) => textEvents().forEach(send) });
  cleanup(t);
  const controller = new AbortController();
  const events = streamSimple(model(fixture.baseUrl), normalizeContext({ messages: [user("one")] }), {
    ...base,
    signal: controller.signal,
  });
  const first = await events.result();
  controller.abort();
  await run(fixture, [user("one"), first, user("two")], { maxTokens: 1024 });
  assert.equal(fixture.connections, 1);
  assert.equal(fixture.frames[1].body.previous_response_id, "resp_test");
});

test("full-input WebSocket turns clear older incremental baselines", async (t) => {
  const fixture = await websocketFixture(t, { message: ({ send }) => textEvents().forEach(send) });
  cleanup(t);
  const first = await run(fixture, [user("one")]);
  await run(fixture, [user("different history")], { transport: "websocket" });
  await run(fixture, [user("one"), first.output, user("two")]);
  assert.equal(fixture.connections, 1);
  assert.ok(fixture.frames.every(({ body }) => body.previous_response_id === undefined));
});

test("thinking, tool arguments and signatures survive a WebSocket tool-result continuation", async (t) => {
  const args = '{"text":"中文参数"}';
  const fixture = await websocketFixture(t, {
    message: ({ body, send }) => {
      if (body.previous_response_id) {
        assert.equal(body.input.length, 1);
        assert.equal(body.input[0].type, "function_call_output");
        textEvents("second").forEach(send);
        return;
      }
      send({ type: "response.created", response: { id: "first" } });
      send({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "r", summary: [] } });
      send({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "分析" });
      send({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "r",
          encrypted_content: "signature",
          summary: [{ type: "summary_text", text: "分析" }],
        },
      });
      const tool = { type: "function_call", id: "fc_1", call_id: "call_1", name: "echo", arguments: "" };
      send({ type: "response.output_item.added", output_index: 1, item: tool });
      for (const delta of [args.slice(0, 8), args.slice(8)])
        send({ type: "response.function_call_arguments.delta", output_index: 1, delta });
      send({ type: "response.output_item.done", output_index: 1, item: { ...tool, arguments: args } });
      send({
        type: "response.completed",
        response: {
          id: "first",
          status: "completed",
          output: [],
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            total_tokens: 14,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 1 },
          },
        },
      });
    },
  });
  cleanup(t);
  const first = await run(fixture, [user("tool")]);
  assert.equal(first.output.stopReason, "toolUse");
  assert.equal(first.output.api, "openai-responses");
  assert.equal(first.output.content[0].thinking, "分析");
  assert.ok(first.output.content[0].thinkingSignature.includes("signature"));
  const call = first.output.content[1];
  assert.deepEqual(call.arguments, { text: "中文参数" });
  assert.equal(first.output.usage.cacheRead, 2);
  assert.equal(first.output.usage.reasoning, 1);
  assert.ok(
    first.events
      .filter((event) => event.type === "toolcall_delta")
      .every((event) => Object.keys(event.partial.content[1].arguments).length === 0),
  );
  const second = await run(fixture, [
    user("tool"),
    first.output,
    {
      role: "toolResult",
      toolCallId: call.id,
      toolName: "echo",
      isError: false,
      timestamp: 0,
      content: [{ type: "text", text: "中文参数" }],
    },
  ]);
  assert.equal(second.output.stopReason, "stop");
  assert.equal(fixture.connections, 1);
  assert.equal(fixture.frames[1].body.previous_response_id, "first");
});
