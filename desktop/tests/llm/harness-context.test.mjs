import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { GenerateRequestSchema } from "xiaowei-contracts";
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
  assert.deepEqual(
    body.tools.map((tool) => tool.name),
    ["Read"],
  );
  assert.deepEqual(
    body.input.map((item) => item.type ?? item.role),
    ["system", "user", "additional_tools", "system", "user"],
  );
  assert.match(JSON.stringify(body.input[0]), /OLD/);
  assert.match(JSON.stringify(body.input[3]), /NEW/);
  assert.doesNotMatch(JSON.stringify(body.input[3]), /OLD/);
  assert.equal(body.input[2].tools[0].name, "Write");
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

test("non-additive tool updates fail explicitly instead of silently folding history", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => {
    requests += 1;
    throw Error("must not fetch");
  });
  const value = request([
    system({ baseline: true, toolsAdded: [tool("Read")] }),
    user("before"),
    system({ toolsRemoved: ["Read"] }),
    user("after"),
  ]);
  await assert.rejects(async () => {
    for await (const _event of generate(
      value,
      new Map([["test", { ...model, api: "openai-completions" }]]),
      new AbortController().signal,
    )) {
    }
  }, /removal or replacement/);
  assert.equal(requests, 0);
});

test("Anthropic rejects deltas whose original position Pi cannot preserve", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => {
    requests += 1;
    throw Error("must not fetch");
  });
  await assert.rejects(async () => {
    for await (const _event of generate(
      request([
        system({ baseline: true, instructions: { base: "old" } }),
        user("before"),
        system({ instructions: { base: "new" } }),
        user("after"),
      ]),
      new Map([["test", { ...model, api: "anthropic-messages" }]]),
      new AbortController().signal,
    )) {
    }
  }, /ordered context updates are unsupported/);
  assert.equal(requests, 0);
});

test("Responses also rejects removal and replacement before reaching the provider", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => {
    requests += 1;
    throw Error("must not fetch");
  });
  for (const replacement of [false, true]) {
    const value = request([
      system({ baseline: true, toolsAdded: [tool("Read")] }),
      user("before"),
      system({
        toolsRemoved: ["Read"],
        toolsAdded: replacement ? [{ ...tool("Read"), description: "updated" }] : [],
      }),
      user("after"),
    ]);
    await assert.rejects(async () => {
      for await (const _event of generate(
        value,
        new Map([["test", model]]),
        new AbortController().signal,
      )) {
      }
    }, /removal or replacement/);
  }
  assert.equal(requests, 0);
});

test("live provider accepts baseline, additions, instruction delta and rebuild", {
  skip: process.env.XIAOWEI_AGENT_LIVE !== "1",
  timeout: 240000,
}, async () => {
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
  const base = "Follow the current named instructions and tool definitions.";
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
      update: {
        instructions: { marker: "On a marker request, reply UPDATED only. Call no tools." },
      },
      prompt: "Marker request.",
      text: "UPDATED",
    },
    { prompt: "Marker request.", text: "UPDATED" },
    {
      reset: true,
      update: {
        baseline: true,
        instructions: { base },
        toolsAdded: [declaration("probe_echo", "count", "number")],
      },
      prompt: "Call probe_echo exactly once with count 7.",
      call: { name: "probe_echo", arguments: { count: 7 } },
    },
  ];
  let messages = [];
  for (const scenario of scenarios) {
    if (scenario.reset) messages = [];
    if (scenario.update) messages.push(system(scenario.update));
    messages.push(user(scenario.prompt));
    let finished;
    const value = create(GenerateRequestSchema, {
      modelRef: selected.id,
      messages,
      maxTokens: Math.min(2048, selected.maxTokens),
      options: { reasoning: document.defaults.thinkingLevel, timeoutMs: 45000 },
    });
    for await (const event of generate(
      value,
      new Map(models.map((entry) => [entry.id, entry])),
      AbortSignal.timeout(50000),
    )) {
      if (event.event.case === "finished") finished = event.event.value.message;
    }
    assert.ok(finished, "model did not complete");
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
