import { once } from "node:events";
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { create } from "@bufbuild/protobuf";
import { GenerateRequestSchema, Llm } from "xiaowei-contracts";
import { bindStreamClient } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachWorker } from "xiaowei-gateway/worker-host";

export const request = (userText = "正常", extra = {}) =>
  create(GenerateRequestSchema, {
    modelRef: "test",
    systemPrompt: "系统提示",
    userText,
    temperature: 0.4,
    maxTokens: 128,
    ...extra,
  });

export async function llmFixture(t, host = new GatewayHost()) {
  const requests = [];
  const disconnected = new Set();
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const text = body.messages.at(-1).content;
    requests.push({ path: incoming.url, auth: incoming.headers.authorization, body });
    outgoing.on("close", () => disconnected.add(text));
    if (text === "http-error") {
      outgoing.writeHead(401, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: { message: "test-key secret response" } }));
      return;
    }
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null, usage) =>
      outgoing.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta, finish_reason }],
          usage,
        })}\n\n`,
      );
    send({ role: "assistant", content: "你" });
    if (["cancel", "close", "slow"].includes(text)) return;
    if (text === "overflow") send({ content: "x".repeat(1024 * 1024) });
    if (text === "reasoning") send({ reasoning_content: "unsupported reasoning" });
    if (text === "tool")
      send({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "write", arguments: "{}" },
          },
        ],
      });
    send({ content: "好" });
    if (text !== "truncated") {
      send({}, text === "length" ? "length" : "stop", {
        prompt_tokens: 8,
        completion_tokens: 2,
        total_tokens: 10,
        prompt_tokens_details: { cached_tokens: 3 },
      });
      outgoing.write("data: [DONE]\n\n");
    }
    outgoing.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const worker = new Worker(new URL("../../out/main/llm-worker.js", import.meta.url), {
    workerData: {
      models: [
        {
          ref: "test",
          id: "text-model",
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          apiKey: "test-key",
          maxTokens: 4096,
          contextWindow: 8192,
        },
      ],
    },
  });
  const owner = await attachWorker(host, "llm", worker);
  t.after(() => owner.close());
  const client = bindStreamClient(Llm, host.client({ caller: "llm-test", trusted: true }));
  return { host, client, owner, worker, requests, disconnected };
}

export async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
