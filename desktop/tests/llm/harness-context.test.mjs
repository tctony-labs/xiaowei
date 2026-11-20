import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { GenerateRequestSchema } from "proto-desktop-ts";
import { toContext } from "../../src/main/services/llm/worker/messages.ts";
import { generate } from "../../src/main/services/llm/worker/provider.ts";

const tool = (name) => ({
  name,
  description: name,
  parametersJson: '{"type":"object","properties":{}}',
});
const system = (update) => ({ message: { case: "systemContext", value: update } });
const user = (text) => ({
  message: {
    case: "user",
    value: {
      timestampMs: 1n,
      content: [{ content: { case: "text", value: { text } } }],
    },
  },
});
const request = (messages, extra = {}) =>
  create(GenerateRequestSchema, {
    modelRef: "test",
    messages,
    ...extra,
  });
const model = {
  id: "test",
  modelId: "fixture",
  name: "fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://fixture.invalid/v1",
  apiKey: "fixture",
  reasoning: false,
  input: ["text"],
  contextWindow: 16000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test("formal worker preserves baseline, instruction delta and addition order", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ error: { message: "capture" } }), { status: 400 });
  });
  const value = request([
    system({
      baseline: true,
      instructions: { base: "BASE", rule: "OLD" },
      toolsAdded: [tool("Read")],
    }),
    user("before"),
    system({ instructions: { rule: "NEW" }, toolsAdded: [tool("Write")] }),
    user("after"),
  ]);
  const context = toContext(value, false);
  assert.equal(context.systemPrompt, undefined);
  assert.equal(context.tools, undefined);
  assert.deepEqual(
    context.messages.map((m) => m.role),
    ["system", "user", "system", "user"],
  );
  for await (const _event of generate(
    value,
    new Map([["test", model]]),
    new AbortController().signal,
  )) {
    // Only HTTP is mocked: exercise the actual worker mapping and Pi serializer.
  }
  assert.equal(bodies.length, 1);
  const body = bodies[0];
  assert.equal(body.tools, undefined);
  assert.deepEqual(
    body.input
      .filter((item) => item.type === "additional_tools")
      .map((item) => item.tools.map((tool) => tool.name)),
    [["Read"], ["Write"]],
  );
  assert.deepEqual(
    body.input.filter((item) => item.role === "user").map((item) => item.content[0].text),
    ["before", "after"],
  );
  const before = body.input.findIndex((item) => JSON.stringify(item).includes("OLD"));
  const after = body.input.findIndex((item) => item.content?.[0]?.text === "after");
  const updated = body.input.findIndex((item) => JSON.stringify(item).includes("NEW"));
  assert.ok(before >= 0 && before < after && after < updated);
  assert.doesNotMatch(JSON.stringify(body.input[updated]), /OLD/);
});

test("invalid updates and duplicate top-level configuration are rejected", () => {
  assert.throws(() => toContext(request([system({ instructions: { base: "delta" } })]), false));
  const initial = system({
    baseline: true,
    instructions: { base: "BASE" },
    toolsAdded: [tool("Read")],
  });
  assert.throws(() => toContext(request([initial, initial, user("x")]), false));
  assert.throws(() =>
    toContext(request([initial, user("x")], { systemPrompt: "duplicate" }), false),
  );
  assert.throws(() =>
    toContext(request([initial, system({ toolsRemoved: ["Missing"] }), user("x")]), false),
  );
});

async function capture(t, config, histories) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
    return new Response(JSON.stringify({ error: { message: "capture" } }), { status: 400 });
  });
  for (const messages of histories) {
    for await (const _event of generate(
      request(messages),
      new Map([["test", { ...model, ...config }]]),
      new AbortController().signal,
    )) {
      // Capture the SDK's actual requests.
    }
  }
  assert.equal(requests.length, histories.length);
  return requests;
}

const original = [
  system({ baseline: true, toolsAdded: [tool("a"), tool("b"), tool("c")] }),
  user("first"),
];
const removed = [...original, system({ toolsRemoved: ["c"] }), user("remove c")];
const added = [...removed, system({ toolsAdded: [tool("d")] }), user("add d")];
const newB = {
  ...tool("b"),
  description: "new b",
  parametersJson: '{"type":"object","properties":{"count":{"type":"integer"}}}',
};
const replaced = [...added, system({ toolsRemoved: ["b"], toolsAdded: [newB] }), user("update b")];
const restored = [...replaced, system({ toolsAdded: [tool("c")] }), user("restore c")];

test("Responses keeps declarations anchored and enforces removal with the allowlist", async (t) => {
  const result = await capture(t, {}, [original, removed, added, replaced, restored]);
  const [initial, deletion, addition, replacement, restoration] = result.map(({ body }) => body);
  assert.ok(result.every(({ body }) => body.tools === undefined));
  assert.deepEqual(deletion.input.slice(0, initial.input.length), initial.input);
  assert.deepEqual(addition.input.slice(0, deletion.input.length), deletion.input);
  assert.deepEqual(replacement.input.slice(0, addition.input.length), addition.input);
  assert.deepEqual(restoration.input.slice(0, replacement.input.length), replacement.input);
  assert.equal(restoration.tool_choice, undefined);
  for (const [body, names] of [
    [deletion, ["a", "b"]],
    [addition, ["a", "b", "d"]],
    [replacement, ["a", "b", "d"]],
  ]) {
    assert.deepEqual(body.tool_choice, {
      type: "allowed_tools",
      mode: "auto",
      tools: names.map((name) => ({ type: "function", name })),
    });
  }
  const declarations = replacement.input.filter((item) => item.type === "additional_tools");
  assert.deepEqual(
    declarations.map((item) => item.tools.map((tool) => tool.name)),
    [["a", "b", "c"], ["d"], ["b"]],
  );
  assert.equal(declarations.at(-1).tools[0].description, newB.description);
  assert.equal(declarations.at(-1).tools[0].parameters.properties.count.type, "integer");
});

test("Chat Completions keeps definitions on deletion and updates them for additions and replacement", async (t) => {
  const config = { api: "openai-completions", compat: { supportsAllowedTools: true } };
  const result = await capture(t, config, [original, removed, added, replaced]);
  const [initial, deletion, addition, replacement] = result.map(({ body }) => body);
  assert.deepEqual(deletion.tools, initial.tools);
  assert.deepEqual(deletion.tool_choice, {
    type: "allowed_tools",
    allowed_tools: {
      mode: "auto",
      tools: ["a", "b"].map((name) => ({ type: "function", function: { name } })),
    },
  });
  assert.deepEqual(
    addition.tools.map((tool) => tool.function.name),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(
    replacement.tools.map((tool) => tool.function.name),
    ["a", "b", "c", "d"],
  );
  assert.equal(replacement.tools[1].function.description, newB.description);
  assert.equal(replacement.tools[1].function.parameters.properties.count.type, "integer");
});

test("Claude sends native removal and inline additions and same-name replacements", async (t) => {
  const config = {
    api: "anthropic-messages",
    provider: "anthropic",
    compat: { supportsMidConvoToolChanges: true },
  };
  const result = await capture(t, config, [original, removed, added, replaced]);
  const [initial, deletion, addition, replacement] = result.map(({ body }) => body);
  assert.ok(
    result.every(({ body }) => JSON.stringify(body.tools) === JSON.stringify(initial.tools)),
  );
  assert.match(result[1].headers.get("anthropic-beta"), /inline-tools-2026-09-15/);
  const updates = (body) =>
    body.messages
      .filter((message) => message.role === "system")
      .flatMap((message) => message.content);
  assert.deepEqual(
    updates(deletion).map(({ type, tool }) => [type, tool.name]),
    [["tool_removal", "c"]],
  );
  const declarations = updates(replacement).filter((block) => block.type === "tool_addition");
  assert.deepEqual(
    declarations.map(({ tool }) => [tool.type, tool.definition.name]),
    [
      ["tool_definition", "d"],
      ["tool_definition", "b"],
    ],
  );
  assert.equal(declarations.at(-1).tool.definition.description, newB.description);
  assert.equal(declarations.at(-1).tool.definition.input_schema.properties.count.type, "integer");
  for (const body of [deletion, addition, replacement]) {
    const input = body.messages.findLastIndex((message) => message.role === "user");
    assert.ok(input >= 0 && input < body.messages.length - 1);
    assert.ok(body.messages.slice(input + 1).every((message) => message.role === "system"));
  }
});

test("Responses without an allowlist falls back to the active tools", async (t) => {
  const responses = await capture(t, { compat: { supportsAllowedTools: false } }, [replaced]);
  assert.deepEqual(responses[0].body.tools.map((tool) => tool.name).sort(), ["a", "b", "d"]);
});

test("Claude without inline support still accepts system updates and current tools", async (t) => {
  const config = { api: "anthropic-messages", provider: "anthropic" };
  const [result] = await capture(t, config, [
    [...replaced, system({ instructions: { policy: "new instruction" } }), user("next")],
  ]);
  assert.deepEqual(result.body.tools.map((tool) => tool.name).sort(), ["a", "b", "d"]);
  assert.match(JSON.stringify(result.body.system), /new instruction/);
});

test("live provider accepts tool additions, removal and same-name replacement", {
  skip: process.env.XIAOWEI_AGENT_LIVE !== "1",
  timeout: 240000,
}, async (t) => {
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadConfig, resolveModels } = await import("../../src/main/services/llm/config.ts");
  const { document } = await loadConfig(
    process.env,
    join(process.env.XIAOWEI_AGENT_HOME ?? join(homedir(), ".xiaowei"), "models.json"),
  );
  const models = resolveModels(document, process.env);
  const selected = models.find((entry) => entry.id === document.defaults.modelRef);
  assert.ok(selected, "default model unavailable");
  const declaration = (name, property, type) => ({
    name,
    description: "Synthetic verification tool with no side effects.",
    parametersJson: JSON.stringify({
      type: "object",
      properties: { [property]: { type } },
      required: [property],
      additionalProperties: false,
    }),
  });
  const echo = declaration("probe_echo", "text", "string");
  const lookup = declaration("probe_lookup", "key", "string");
  const base =
    "Follow the current named instructions and tool definitions.\n" +
    Array.from(
      { length: 180 },
      (_, index) =>
        `Fixture rule ${index + 1}. Apply the latest declared tool schema to this request.`,
    ).join("\n");
  const scenarios = [
    {
      update: { baseline: true, instructions: { base }, toolsAdded: [echo] },
      prompt: 'Call probe_echo exactly once with text "seven".',
      call: { name: "probe_echo", arguments: { text: "seven" } },
    },
    {
      update: { toolsAdded: [lookup] },
      prompt: 'Call probe_lookup exactly once with key "sample".',
      call: { name: "probe_lookup", arguments: { key: "sample" } },
    },
    {
      update: { toolsRemoved: ["probe_lookup"] },
      prompt: "If probe_lookup is unavailable, reply UNAVAILABLE only. Do not call other tools.",
      text: "UNAVAILABLE",
    },
    {
      update: {
        instructions: { marker: "On a marker request, reply UPDATED only. Call no tools." },
      },
      prompt: "Marker request.",
      text: "UPDATED",
    },
    { prompt: "Marker request.", text: "UPDATED" },
    {
      update: {
        toolsRemoved: ["probe_echo"],
        toolsAdded: [declaration("probe_echo", "count", "number")],
      },
      prompt: "Call probe_echo exactly once with count 7.",
      call: { name: "probe_echo", arguments: { count: 7 } },
    },
  ];
  const messages = [];
  const sessionId = randomUUID();
  t.after(() => cleanupSessionResources(sessionId));
  for (const [index, scenario] of scenarios.entries()) {
    if (scenario.update) messages.push(system(scenario.update));
    messages.push(user(scenario.prompt));
    let finished;
    const value = create(GenerateRequestSchema, {
      modelRef: selected.id,
      messages,
      maxTokens: Math.min(2048, selected.maxTokens),
      options: { sessionId, reasoning: document.defaults.thinkingLevel, timeoutMs: 45000 },
    });
    for await (const event of generate(
      value,
      new Map(models.map((entry) => [entry.id, entry])),
      AbortSignal.timeout(50000),
    )) {
      if (event.event.case === "finished") finished = event.event.value.message;
    }
    assert.ok(finished, "model did not complete");
    console.info("live tool update", { step: index + 1, cachedTokens: finished.usage?.cacheRead });
    const calls = finished.content
      .filter((block) => block.content.case === "toolCall")
      .map((block) => block.content.value);
    if (scenario.call) {
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, scenario.call.name);
      assert.deepEqual(JSON.parse(calls[0].argumentsJson), scenario.call.arguments);
    } else {
      assert.equal(calls.length, 0);
      assert.equal(
        finished.content
          .filter((block) => block.content.case === "text")
          .map((block) => block.content.value.text)
          .join("")
          .trim(),
        scenario.text,
      );
    }
    messages.push({ message: { case: "assistant", value: finished } });
    for (const call of calls) {
      messages.push({
        message: {
          case: "toolResult",
          value: {
            toolCallId: call.id,
            toolName: call.name,
            content: [{ content: { case: "text", value: { text: call.argumentsJson } } }],
            timestampMs: 1n,
          },
        },
      });
    }
  }
});
