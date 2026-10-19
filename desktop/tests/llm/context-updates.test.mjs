import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { normalizeConfig } from "../../src/main/services/llm/config.ts";
import { apis } from "../../src/main/services/llm/worker/apis.ts";
import { toContext } from "../../src/main/services/llm/worker/messages.ts";
import { toPiModel } from "../../src/main/services/llm/worker/provider.ts";
import { request } from "../fixtures/llm.mjs";
import { configDocument } from "../fixtures/model-config.mjs";

const tool = (name, type = "string") => ({
  name,
  description: `Test ${name}`,
  parameters: { type: "object", properties: { value: { type } }, required: ["value"] },
});

const user = (content) => ({ role: "user", content, timestamp: 1 });
const system = (updates) => ({ role: "system", content: "", timestamp: 2, ...updates });
const baseline = () =>
  system({
    content: "BASE",
    sections: { policy: "POLICY_OLD", obsolete: "OBSOLETE" },
    toolsAdded: [tool("alpha")],
  });

function modelConfig(api, compat = {}) {
  return {
    id: "test",
    modelId: "test-model",
    name: "Test",
    provider: api === "anthropic-messages" ? "anthropic" : "openai",
    api,
    apiKey: "fixture-key",
    baseUrl: "https://provider-fixture.invalid/v1",
    input: ["text"],
    reasoning: false,
    contextWindow: 16384,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat,
  };
}

// Exercise the worker's real provider selection and SDK serialization. Only HTTP is replaced.
// The current PB cannot carry SystemMessage, so these are provider-boundary characterization tests.
async function capture(api, messages, compat = {}, simple = false) {
  const bodies = [];
  const model = toPiModel(modelConfig(api, compat));
  const context = normalizeContext({ messages });
  const provider = apis[api]();
  const stream = provider[simple ? "streamSimple" : "stream"](model, context, {
    apiKey: "fixture-key",
    transport: "sse",
    cacheRetention: "none",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      // Stop at the HTTP boundary: no live model call and no assertion about API acceptance.
      return new Response(
        JSON.stringify({ error: { type: "invalid_request_error", message: "capture complete" } }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });
  const result = await stream.result();
  assert.equal(result.stopReason, "error");
  assert.equal(bodies.length, 1);
  return bodies[0];
}

const enabled = {
  "openai-responses": { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
  "openai-completions": {
    supportsMidConvoSystemMessages: true,
    supportsMidConvoToolAdditions: true,
  },
  "anthropic-messages": { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};

const messagesOf = (body) => body.input ?? body.messages;
const toolsOf = (body) => (body.tools ?? []).map((entry) => entry.function ?? entry);

for (const api of Object.keys(enabled)) {
  test(`${api}: defaults collapse updates into the current leading prompt and tools`, async () => {
    const body = await capture(api, [
      baseline(),
      user("before"),
      system({
        sections: { policy: "POLICY_NEW", obsolete: null },
        toolsRemoved: [{ name: "alpha" }],
        toolsAdded: [tool("beta")],
      }),
      user("after"),
    ]);
    const leading = body.system ?? messagesOf(body)[0];
    assert.match(JSON.stringify(leading), /POLICY_NEW/);
    assert.doesNotMatch(JSON.stringify(body), /POLICY_OLD|OBSOLETE|Removed system prompt section/);
    assert.deepEqual(
      toolsOf(body).map((entry) => entry.name),
      ["beta"],
    );
    assert.equal(
      messagesOf(body).filter((entry) => entry.role === "system").length,
      body.system ? 0 : 1,
    );
  });

  test(`${api}: enabled updates retain section replacement and removal notices`, async () => {
    const body = await capture(
      api,
      [
        baseline(),
        user("before"),
        system({ sections: { policy: "POLICY_NEW", obsolete: null } }),
        user("after"),
      ],
      enabled[api],
    );
    const leading = body.system ?? messagesOf(body)[0];
    assert.match(JSON.stringify(leading), /POLICY_OLD/);
    const updates = messagesOf(body).filter((entry) =>
      JSON.stringify(entry).includes("POLICY_NEW"),
    );
    assert.equal(updates.length, 1);
    assert.match(JSON.stringify(updates[0]), /Updated system prompt section/);
    assert.match(JSON.stringify(updates[0]), /Removed system prompt section/);
    const last = messagesOf(body).at(-1);
    // Anthropic moves an update before a user message to after that user message.
    assert.equal(last.role, api === "anthropic-messages" ? "system" : "user");
  });

  test(`${api}: schema replacement uses full tools even with flags`, async () => {
    const body = await capture(
      api,
      [
        baseline(),
        user("before"),
        system({ toolsRemoved: [{ name: "alpha" }], toolsAdded: [tool("alpha", "number")] }),
        user("after"),
      ],
      enabled[api],
    );
    const definitions = toolsOf(body);
    assert.deepEqual(
      definitions.map((entry) => entry.name),
      ["alpha"],
    );
    assert.equal(
      (definitions[0].parameters ?? definitions[0].input_schema).properties.value.type,
      "number",
    );
    assert.doesNotMatch(
      JSON.stringify(messagesOf(body)),
      /additional_tools|tool_addition|tool_removal/,
    );
    assert.ok(messagesOf(body).every((entry) => entry.tools === undefined));
  });
}

test("Responses: removals disable all anchored tool additions", async () => {
  const messages = [
    baseline(),
    user("before"),
    system({ toolsAdded: [tool("beta")] }),
    user("after"),
  ];
  const addition = await capture("openai-responses", messages, enabled["openai-responses"], true);
  assert.deepEqual(
    toolsOf(addition).map((entry) => entry.name),
    ["alpha"],
  );
  const addedTools = addition.input.find((entry) => entry.type === "additional_tools").tools;
  assert.deepEqual(
    addedTools.map((entry) => entry.name),
    ["beta"],
  );

  const removal = await capture(
    "openai-responses",
    [...messages, system({ toolsRemoved: [{ name: "alpha" }] }), user("removed")],
    enabled["openai-responses"],
  );
  assert.deepEqual(
    toolsOf(removal).map((entry) => entry.name),
    ["beta"],
  );
  assert.ok(removal.input.every((entry) => entry.type !== "additional_tools"));
  assert.doesNotMatch(JSON.stringify(removal.input), /alpha|beta|tool_removal/);
});

test("Anthropic: enabled distinct-name additions and removals produce native blocks", async () => {
  const body = await capture(
    "anthropic-messages",
    [
      baseline(),
      user("before"),
      system({ toolsAdded: [tool("beta")], toolsRemoved: [{ name: "alpha" }] }),
      user("after"),
    ],
    enabled["anthropic-messages"],
  );
  const blocks = body.messages.flatMap((entry) => entry.content);
  assert.equal(blocks.find((block) => block.type === "tool_addition").tool.name, "beta");
  assert.equal(blocks.find((block) => block.type === "tool_removal").tool.name, "alpha");
  assert.equal(toolsOf(body).find((entry) => entry.name === "beta").defer_loading, true);
});

test("current worker boundary cannot accept system updates or configure their Pi flags", () => {
  const invalid = (error) => error.detail?.code === "INVALID_ARGUMENT";
  assert.throws(
    () =>
      toContext(
        {
          ...request(""),
          messages: [{ message: { case: "system", value: {} } }],
        },
        false,
      ),
    invalid,
  );

  for (const api of Object.keys(enabled)) {
    assert.doesNotThrow(() => normalizeConfig(configDocument([modelConfig(api)])));
    assert.throws(() => normalizeConfig(configDocument([modelConfig(api, enabled[api])])), invalid);
  }
});
