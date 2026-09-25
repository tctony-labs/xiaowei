import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { create } from "@bufbuild/protobuf";
import { GenerateRequestSchema, ListModelsRequestSchema, Llm, ModelCatalog } from "xiaowei-contracts";
import { bindStreamClient } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachLlm } from "../src/main/services/llm/host.ts";
import { loadStartupModels } from "../src/main/services/llm/startup-config.ts";

const user = (text) => ({
  message: {
    case: "user",
    value: { timestampMs: BigInt(Date.now()), content: [{ content: { case: "text", value: { text } } }] },
  },
});
const tools = [
  {
    name: "echo",
    description: "Returns the given text unchanged.",
    parametersJson: JSON.stringify({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    }),
  },
];

let owner;
try {
  const { values } = parseArgs({ options: { model: { type: "string" }, mode: { type: "string" } } });
  const modes = ["complete", "cancel", "thinking", "cancel-thinking", "tools", "catalog", "image"];
  if (!values.model || !modes.includes(values.mode)) throw new Error("invalid arguments");
  const models = await loadStartupModels(process.env);
  const model = models.find((entry) => entry.id === values.model);
  if (!model) throw new Error("unknown model");
  const host = new GatewayHost();
  owner = await attachLlm(host, models, new URL("../out/main/llm-worker.js", import.meta.url));
  const endpoint = host.client({ caller: "llm-verification", trusted: true });
  const client = bindStreamClient(Llm, endpoint);

  async function generate(input, cancelKind) {
    const stream = await client.generate(
      create(GenerateRequestSchema, {
        modelRef: model.id,
        maxTokens: Math.min(4096, model.maxTokens),
        ...input,
      }),
    );
    let text = "";
    let thinking = false;
    let toolDelta = false;
    let usage = 0;
    let finished = 0;
    let message;
    let cancelled = false;
    try {
      for await (const chunk of stream) {
        const event = chunk.event;
        if (event.case === "textDelta") text += event.value.text;
        if (event.case === "blockDelta" && event.value.kind === "thinking") thinking = true;
        if (event.case === "blockDelta" && event.value.kind === "toolcall") toolDelta = true;
        if (event.case === "usage") usage++;
        if (event.case === "finished") {
          finished++;
          message = event.value.message;
        }
        if (event.case === "failed") throw new Error("provider failed");
        if ((cancelKind === "text" && text) || (cancelKind === "thinking" && thinking)) {
          await stream.cancel();
          cancelled = true;
          break;
        }
      }
    } finally {
      await stream.cancel();
    }
    if (cancelKind) assert.ok(cancelled);
    else {
      assert.equal(usage, 1);
      assert.equal(finished, 1);
      assert.ok(message);
    }
    return { text, thinking, toolDelta, message };
  }

  if (values.mode === "catalog") {
    const catalog = bindStreamClient(ModelCatalog, endpoint);
    const stream = await catalog.listModels(create(ListModelsRequestSchema, { modelRef: model.id }));
    let count = 0;
    try {
      for await (const page of stream) count += page.models.length;
    } finally {
      await stream.cancel();
    }
    assert.ok(count > 0);
    console.log(`Catalog: ${count} models.`);
  } else if (values.mode === "image") {
    const prompt = user("Describe this image in one short sentence.");
    prompt.message.value.content.push({
      content: {
        case: "image",
        value: {
          mimeType: "image/png",
          data: Uint8Array.from(
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzC" +
                "MP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==",
              "base64",
            ),
          ),
        },
      },
    });
    const result = await generate({ messages: [prompt] });
    assert.ok(result.text);
    console.log("Image input: passed.");
  } else if (values.mode === "tools") {
    const messages = [
      user('Call echo exactly once with text "verification-echo". After its result, repeat that text.'),
    ];
    const first = await generate({ messages, tools, options: { reasoning: "high" } });
    assert.ok(first.toolDelta);
    const calls = first.message.content.filter((block) => block.content.case === "toolCall");
    assert.equal(calls.length, 1);
    const call = calls[0].content.value;
    assert.equal(call.name, "echo");
    assert.deepEqual(JSON.parse(call.argumentsJson), { text: "verification-echo" });
    const second = await generate({
      messages: [
        ...messages,
        { message: { case: "assistant", value: first.message } },
        {
          message: {
            case: "toolResult",
            value: {
              toolCallId: call.id,
              toolName: call.name,
              timestampMs: BigInt(Date.now()),
              content: [{ content: { case: "text", value: { text: "verification-echo" } } }],
            },
          },
        },
      ],
      tools,
      options: { reasoning: "high" },
    });
    assert.ok(second.text.includes("verification-echo"));
    console.log("Tool call, arguments, history replay and result: passed.");
  } else if (values.mode === "thinking" || values.mode === "cancel-thinking") {
    const result = await generate(
      {
        messages: [user("Calculate 37 * 49 and briefly explain the arithmetic.")],
        options: { reasoning: "high" },
      },
      values.mode === "cancel-thinking" ? "thinking" : undefined,
    );
    assert.ok(result.thinking);
    if (values.mode === "thinking") {
      assert.ok(result.text.includes("1813") || result.text.includes("1,813"));
      assert.ok(result.message.content.some((block) => block.content.case === "thinking"));
    }
    console.log("Thinking: passed.");
  } else {
    const result = await generate(
      { userText: "Reply with a short greeting." },
      values.mode === "cancel" ? "text" : undefined,
    );
    assert.ok(result.text);
    console.log(values.mode === "cancel" ? "Cancelled." : "Completed.");
  }
} catch {
  console.error("LLM verification failed; check configuration and provider availability.");
  process.exitCode = 1;
} finally {
  try {
    await owner?.close();
  } catch {
    console.error("LLM worker cleanup failed.");
    process.exitCode = 1;
  }
}
