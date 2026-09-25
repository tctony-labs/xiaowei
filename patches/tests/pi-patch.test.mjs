import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

// Resolve the patched version installed for its actual consumer.
const consumerUrl = new URL("../../desktop/package.json", import.meta.url).href;
const { stream: completions } = await import(
  import.meta.resolve("@earendil-works/pi-ai/api/openai-completions", consumerUrl)
);
const { stream: responses } = await import(
  import.meta.resolve("@earendil-works/pi-ai/api/openai-responses", consumerUrl)
);

const args = { file_path: "notes.md", content: "中文参数".repeat(512) };
const json = JSON.stringify(args);
const fragments = json.match(/.{1,7}/gs);
const context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function completionEvents() {
  return [
    {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: "" } }],
          },
          finish_reason: null,
        },
      ],
    },
    ...fragments.map((fragment) => ({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] },
          finish_reason: null,
        },
      ],
    })),
    {
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    },
    "[DONE]",
  ];
}

function responseEvents() {
  const item = { type: "function_call", call_id: "call_1", id: "fc_1", name: "write" };
  return [
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    ...fragments.map((delta) => ({ type: "response.function_call_arguments.delta", output_index: 0, delta })),
    { type: "response.function_call_arguments.done", output_index: 0, arguments: json },
    { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: json } },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      },
    },
  ];
}

for (const [api, stream, events, path] of [
  ["openai-completions", completions, completionEvents, "/chat/completions"],
  ["openai-responses", responses, responseEvents, "/responses"],
]) {
  test(`patched Pi ${api} preserves deltas and parses final tool arguments`, { timeout: 10_000 }, async (t) => {
    const requests = [];
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the request body before completing the mock response.
      }
      requests.push(request.url);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of events()) {
        response.write(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const model = {
      id: "m",
      name: "m",
      api,
      provider: "test",
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 4096,
    };
    const deltas = [];
    let final;
    let done = 0;
    for await (const event of stream(model, context, { apiKey: "test-key" })) {
      if (event.type === "toolcall_delta" && event.delta.length > 0) {
        deltas.push(event.delta);
        // Inspect immediately: Pi reuses and mutates the partial message object.
        assert.deepEqual(event.partial.content[event.contentIndex].arguments, {});
      } else if (event.type === "toolcall_end") {
        final = event.toolCall.arguments;
      } else if (event.type === "done") {
        done++;
        assert.equal(event.reason, "toolUse");
      } else if (event.type === "error") {
        assert.fail(event.error.errorMessage);
      }
    }
    assert.deepEqual(requests, [path]);
    assert.deepEqual(deltas, fragments);
    assert.deepEqual(final, args);
    assert.equal(done, 1);
  });
}
