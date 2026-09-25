import { once } from "node:events";
import { createServer } from "node:http";
import { create } from "@bufbuild/protobuf";
import { GenerateRequestSchema, Llm } from "xiaowei-contracts";
import { bindStreamClient } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachLlm } from "../../src/main/services/llm/host.ts";

export const request = (userText = "正常", extra = {}) =>
  create(GenerateRequestSchema, {
    modelRef: "test",
    systemPrompt: "系统提示",
    userText,
    temperature: 0.4,
    maxTokens: 128,
    ...extra,
  });

export async function llmFixture(t, host = new GatewayHost(), api = "openai-completions") {
  const requests = [];
  const disconnected = new Set();
  const resume = new Map();
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const content = body.messages?.at(-1).content ?? body.input.at(-1).content;
    const text = typeof content === "string" ? content : content[0].text;
    requests.push({
      path: incoming.url,
      auth: incoming.headers.authorization ?? `Bearer ${incoming.headers["x-api-key"]}`,
      body,
    });
    outgoing.on("close", () => disconnected.add(text));
    if (text === "http-error") {
      outgoing.writeHead(401, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ error: { message: "test-key secret response" } }));
      return;
    }
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    if (text.startsWith("features")) {
      const send = (event) => outgoing.write(`event: ${event.type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`);
      const args = '{"text":"中文参数"}';
      if (new URL(incoming.url, "http://localhost").pathname.endsWith("/messages")) {
        send({
          type: "message_start",
          message: { id: "msg_features", model: body.model, usage: { input_tokens: 5, output_tokens: 0 }, content: [] },
        });
        send({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
        send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "分析" } });
        if (text === "features-cancel-thinking") return;
        send({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "signed-thinking" },
        });
        send({ type: "content_block_stop", index: 0 });
        send({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
        send({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "调用工具" } });
        send({ type: "content_block_stop", index: 1 });
        send({
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "call_1", name: "echo", input: {} },
        });
        for (const fragment of [args.slice(0, 9), args.slice(9)])
          send({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: fragment } });
        if (text === "features-cancel-tool") return;
        send({ type: "content_block_stop", index: 2 });
        send({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } });
        send({ type: "message_stop" });
      } else if (new URL(incoming.url, "http://localhost").pathname.endsWith("/responses")) {
        send({ type: "response.created", response: { id: "resp_features" } });
        send({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "reasoning", id: "reasoning_1", summary: [] },
        });
        send({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "分析" });
        if (text === "features-cancel-thinking") return;
        send({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "reasoning_1",
            encrypted_content: "signed-thinking",
            summary: [{ type: "summary_text", text: "分析" }],
          },
        });
        const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "echo", arguments: "" };
        send({ type: "response.output_item.added", output_index: 1, item: call });
        for (const delta of [args.slice(0, 9), args.slice(9)])
          send({ type: "response.function_call_arguments.delta", output_index: 1, delta });
        if (text === "features-cancel-tool") return;
        send({ type: "response.output_item.done", output_index: 1, item: { ...call, arguments: args } });
        send({
          type: "response.completed",
          response: {
            id: "resp_features",
            status: "completed",
            output: [],
            usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
          },
        });
      } else {
        const chunk = (delta, finish_reason = null, usage) =>
          send({ choices: [{ index: 0, delta, finish_reason }], usage });
        chunk({ role: "assistant", reasoning_content: "分析" });
        if (text === "features-cancel-thinking") return;
        chunk({ content: "调用工具" });
        chunk({
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "echo", arguments: args.slice(0, 9) } },
          ],
        });
        chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(9) } }] });
        if (text === "features-cancel-tool") return;
        chunk({}, "tool_calls", { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });
        outgoing.write("data: [DONE]\n\n");
      }
      outgoing.end();
      return;
    }
    if (new URL(incoming.url, "http://localhost").pathname.endsWith("/messages")) {
      const send = (event) => outgoing.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
        },
      });
      send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你" } });
      const finish = () => {
        send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } });
        send({ type: "content_block_stop", index: 0 });
        if (text !== "truncated") {
          send({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 2 },
          });
          send({ type: "message_stop" });
        }
        outgoing.end();
      };
      if (["cancel", "slow", "close"].includes(text)) return;
      if (text === "paused") resume.set(text, finish);
      else finish();
      return;
    }
    if (new URL(incoming.url, "http://localhost").pathname.endsWith("/responses")) {
      const send = (event) => outgoing.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: "response.created", response: { id: "response_test" } });
      const item = { id: "msg_test", type: "message", role: "assistant", content: [] };
      send({ type: "response.output_item.added", output_index: 0, item });
      send({ type: "response.output_text.delta", output_index: 0, delta: "你" });
      const finish = () => {
        send({ type: "response.output_text.delta", output_index: 0, delta: "好" });
        send({
          type: "response.output_item.done",
          output_index: 0,
          item: { ...item, content: [{ type: "output_text", text: "你好", annotations: [] }] },
        });
        if (text !== "truncated")
          send({
            type: "response.completed",
            response: {
              id: "response_test",
              status: "completed",
              output: [],
              usage: {
                input_tokens: 8,
                output_tokens: 2,
                total_tokens: 10,
                input_tokens_details: { cached_tokens: 3 },
              },
            },
          });
        outgoing.end();
      };
      if (["cancel", "slow", "close"].includes(text)) return;
      if (text === "paused") resume.set(text, finish);
      else finish();
      return;
    }
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
    const finish = () => {
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
    };
    if (text === "paused") resume.set(text, finish);
    else finish();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const model = {
    id: "test",
    modelId: "text-model",
    name: "Test",
    api,
    provider: "openai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: api === "openai-completions" ? { maxTokensField: "max_tokens" } : {},
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiKey: "test-key",
    maxTokens: 4096,
    contextWindow: 8192,
  };
  const owner = await attachLlm(host, [model], new URL("../../out/main/llm-worker.js", import.meta.url));
  t.after(() => owner.close());
  const client = bindStreamClient(Llm, host.client({ caller: "llm-test", trusted: true }));
  return { host, client, owner, model, requests, disconnected, resume };
}

export async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
