import assert from "node:assert/strict";
import { test } from "node:test";
import { textEvents } from "../../../patches/tests/fixtures/websocket.mjs";
import { updateScenarios, verifyContextUpdates } from "../../scripts/verify-context-updates.mjs";

const config = {
  id: "test",
  modelId: "test-model",
  name: "Test",
  provider: "openai",
  api: "openai-responses",
  apiKey: "fixture-key",
  baseUrl: "https://provider-fixture.invalid/v1",
  input: ["text"],
  reasoning: true,
  contextWindow: 16384,
  maxTokens: 2048,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function responseFor(scenario, index) {
  let events = textEvents(`response_${index}`, scenario.text ?? "");
  if (scenario.call) {
    const item = {
      type: "function_call",
      id: `fc_${index}`,
      call_id: `call_${index}`,
      name: scenario.call.name,
      arguments: JSON.stringify(scenario.call.arguments),
    };
    events = [
      events[0],
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments },
      { type: "response.output_item.done", output_index: 0, item },
      events.at(-1),
    ];
  }
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

test("Responses encoding retains deltas and resets only at rebuild", async () => {
  const scenarios = updateScenarios();
  const requests = [];
  const reports = [];
  await verifyContextUpdates(config, {
    fetch: async (_url, init) => {
      const index = requests.length;
      requests.push(JSON.parse(init.body));
      return responseFor(scenarios[index], index);
    },
    report: (result) => reports.push(result),
  });
  assert.equal(reports.length, 6);
  for (const [index, body] of requests.entries()) {
    assert.deepEqual(
      body.tools.map((entry) => entry.name),
      scenarios[index].active,
    );
    assert.ok(body.input.every((entry) => entry.type !== "additional_tools"));
    const instructions = body.input.filter((entry) => entry.role === "developer");
    assert.equal(instructions.length, index < 4 ? index + 1 : index === 4 ? 4 : 1);
    if (index > 0 && index < 5) assert.deepEqual(body.input[0], requests[0].input[0]);
  }
  const replacement = requests[2].input
    .filter((entry) => entry.role === "developer")
    .at(-1).content;
  assert.match(replacement, /"removed":\["probe_echo"\]/);
  assert.match(replacement, /"count":\{"type":"number"\}/);
  assert.doesNotMatch(replacement, /probe_lookup/);
  const removal = requests[3].input.filter((entry) => entry.role === "developer").at(-1).content;
  assert.match(removal, /"removed":\["probe_lookup"\]/);
  assert.match(removal, /UNAVAILABLE_NEW/);
  assert.deepEqual(
    requests[4].input.filter((entry) => entry.role === "developer"),
    requests[3].input.filter((entry) => entry.role === "developer"),
  );
  assert.doesNotMatch(JSON.stringify(requests[5].input), /UNAVAILABLE_OLD|Capability update/);
});

test("verification rejects an attempted call to a removed tool", async () => {
  const scenarios = updateScenarios();
  let index = 0;
  await assert.rejects(
    verifyContextUpdates(config, {
      fetch: async () => {
        const current = index++;
        const scenario =
          current === 3
            ? { call: { name: "probe_lookup", arguments: { key: "sample" } } }
            : scenarios[current];
        return responseFor(scenario, current);
      },
    }),
    /removed tool must not be called/,
  );
  assert.equal(index, 4);
});

test("verification rejects unsupported APIs before requesting", async () => {
  await assert.rejects(
    verifyContextUpdates(
      { ...config, api: "anthropic-messages" },
      {
        fetch: async () => assert.fail("must not request"),
      },
    ),
    /Responses only/,
  );
});
