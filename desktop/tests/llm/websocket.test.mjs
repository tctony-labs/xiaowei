import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { GenerateRequestSchema, Llm } from "xiaowei-contracts";
import { bindStreamClient } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { textEvents, until, websocketFixture } from "../../../patches/tests/fixtures/websocket.mjs";
import { attachLlm } from "../../src/main/services/llm/host.ts";

const user = (text) => ({
  message: {
    case: "user",
    value: {
      timestampMs: 0n,
      content: [{ content: { case: "text", value: { text } } }],
    },
  },
});

async function setup(t) {
  const fixture = await websocketFixture(t, {
    message: ({ send, body }) => {
      const prompt = body.input.at(-1).content?.[0]?.text;
      const events = textEvents();
      (prompt === "pause" ? events.slice(0, 4) : events).forEach(send);
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
  const model = {
    id: "model",
    name: "Model",
    modelId: "model",
    provider: "openai",
    api: "openai-responses",
    apiKey: "fixture-key",
    baseUrl: fixture.baseUrl,
    defaultTransport: "auto",
    reasoning: false,
    input: ["text"],
    contextWindow: 16384,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const host = new GatewayHost();
  const owner = await attachLlm(host, [model], new URL("../../out/main/llm-worker.js", import.meta.url));
  t.after(() => owner.close());
  const client = bindStreamClient(Llm, host.client({ caller: "websocket-test", trusted: true }));
  const request = (messages, options = {}) =>
    create(GenerateRequestSchema, {
      modelRef: model.id,
      messages,
      options: { sessionId: "session", ...options },
    });
  const collect = async (messages, options) => {
    const result = [];
    for await (const event of await client.generate(request(messages, options))) result.push(event.event);
    return result;
  };
  return { fixture, model, owner, client, request, collect };
}

test("built worker reuses Responses sockets through Gateway and configuration updates preserve identity", async (t) => {
  const { fixture, model, owner, collect } = await setup(t);
  const first = await collect([user("one")]);
  assert.equal(first.at(-1).case, "finished");
  const assistant = first.at(-1).value.message;
  assert.equal(assistant.api, "openai-responses");
  const second = await collect([user("one"), { message: { case: "assistant", value: assistant } }, user("two")]);
  assert.equal(second.at(-1).case, "finished");
  assert.equal(fixture.connections, 1);
  assert.equal(fixture.frames[1].body.previous_response_id, "resp_test");
  assert.equal(fixture.frames[1].body.input.length, 1);
  await owner.updateModels([{ ...model, apiKey: "new-key" }]);
  await collect([user("new credential")]);
  assert.equal(fixture.connections, 2);
  assert.equal(fixture.requests[1].headers.authorization, "Bearer new-key");
  await owner.updateModels([{ ...model, defaultTransport: "sse" }]);
  await collect([user("HTTP")]);
  assert.equal(fixture.connections, 2);
  assert.equal(fixture.requests.at(-1).method, "POST");
  await owner.close();
  await until(() => fixture.closed === 2);
});

test("Gateway cancellation and owner shutdown discard in-flight WebSockets", async (t) => {
  const { fixture, owner, client, request } = await setup(t);
  const first = await client.generate(request([user("pause")]));
  while ((await first.next()).value.event.case !== "textDelta") {}
  await first.cancel();
  await until(() => fixture.closed === 1);
  const second = await client.generate(request([user("pause")]));
  await second.next();
  await owner.close();
  await until(() => fixture.closed === 2);
});
