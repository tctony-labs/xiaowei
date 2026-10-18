// Opt-in provider-boundary experiment; does not modify app configuration, PB, or session history.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { normalizeContext } from "@earendil-works/pi-ai";
import { loadConfig, resolveModels } from "../src/main/services/llm/config.ts";
import { apis } from "../src/main/services/llm/worker/apis.ts";
import { toPiModel } from "../src/main/services/llm/worker/provider.ts";

const tool = (name, property, type) => ({
  name,
  description: "Synthetic verification tool. Returns its argument without side effects.",
  parameters: {
    type: "object",
    properties: { [property]: { type } },
    required: [property],
    additionalProperties: false,
  },
});

const echoV1 = tool("probe_echo", "text", "string");
const echoV2 = tool("probe_echo", "count", "number");
const lookup = tool("probe_lookup", "key", "string");
const user = (content) => ({ role: "user", content, timestamp: 0 });
const system = (fields) => ({ role: "system", content: "", timestamp: 0, ...fields });
const baseInstructions = [
  "This is a synthetic capability-update test. Call only currently available tools.",
  "Later system updates supersede the named earlier instructions and tool definitions.",
  "When a requested tool is unavailable, do not call another tool; " +
    "reply with the active unavailable marker only.",
].join("\n");
const marker = (value) => `<unavailable_marker>${value}</unavailable_marker>`;

// Test-only candidate: explicit delta plus Pi's current executable declarations.
export function capabilityUpdate({ added = [], removed = [], sections } = {}) {
  return system({
    content: `Capability update, effective now:\n${JSON.stringify({ removed, added })}`,
    toolsAdded: added,
    toolsRemoved: removed.map((name) => ({ name })),
    ...(sections ? { sections } : {}),
  });
}

export function updateScenarios() {
  return [
    {
      name: "baseline",
      update: system({
        content: baseInstructions,
        sections: { unavailable_marker: marker("UNAVAILABLE_OLD") },
        toolsAdded: [echoV1],
      }),
      prompt:
        "Call probe_echo exactly once with value seven, " +
        "using its declared parameter name and type.",
      call: { name: "probe_echo", arguments: { text: "seven" } },
      active: ["probe_echo"],
    },
    {
      name: "addition",
      update: capabilityUpdate({ added: [lookup] }),
      prompt: 'Call probe_lookup exactly once with key "sample".',
      call: { name: "probe_lookup", arguments: { key: "sample" } },
      active: ["probe_echo", "probe_lookup"],
    },
    {
      name: "replacement",
      update: capabilityUpdate({ removed: ["probe_echo"], added: [echoV2] }),
      prompt:
        "Call probe_echo exactly once with value 7, using its current parameter name and type.",
      call: { name: "probe_echo", arguments: { count: 7 } },
      active: ["probe_lookup", "probe_echo"],
    },
    {
      name: "removal-and-instruction-update",
      update: capabilityUpdate({
        removed: ["probe_lookup"],
        sections: { unavailable_marker: marker("UNAVAILABLE_NEW") },
      }),
      prompt:
        'Call probe_lookup with key "sample" if available; ' +
        "otherwise follow the unavailable-tool rule.",
      text: "UNAVAILABLE_NEW",
      active: ["probe_echo"],
    },
    {
      name: "unchanged",
      prompt:
        'Call probe_lookup with key "sample" if available; ' +
        "otherwise follow the unavailable-tool rule.",
      text: "UNAVAILABLE_NEW",
      active: ["probe_echo"],
    },
    {
      name: "rebuilt-baseline",
      reset: true,
      update: system({
        content: baseInstructions,
        sections: { unavailable_marker: marker("UNAVAILABLE_NEW") },
        toolsAdded: [echoV2],
      }),
      prompt:
        "Call probe_echo exactly once with value 7, using its current parameter name and type.",
      call: { name: "probe_echo", arguments: { count: 7 } },
      active: ["probe_echo"],
    },
  ];
}

export async function verifyContextUpdates(config, { fetch, report = () => {} } = {}) {
  assert.equal(config.api, "openai-responses", "This experiment covers Responses only");
  const model = toPiModel(config);
  model.compat = {
    ...model.compat,
    supportsMidConvoSystemMessages: true,
    supportsAdditionalTools: false,
    supportsToolSearch: false,
  };
  const provider = apis[config.api]();
  let messages = [];
  for (const scenario of updateScenarios()) {
    if (scenario.reset) messages = [];
    if (scenario.update) messages.push(scenario.update);
    messages.push(user(scenario.prompt));
    const stream = provider.streamSimple(model, normalizeContext({ messages }), {
      apiKey: config.apiKey,
      transport: "sse",
      cacheRetention: "none",
      reasoning: config.reasoning ? "low" : undefined,
      maxTokens: Math.min(2048, config.maxTokens),
      maxRetries: 0,
      timeoutMs: 45000,
      signal: AbortSignal.timeout(45000),
      ...(fetch ? { fetch } : {}),
    });
    const result = await stream.result();
    // Never print SDK errors, headers, prompts, or configuration containing credentials.
    assert.ok(
      ["stop", "toolUse"].includes(result.stopReason),
      `${scenario.name}: provider did not finish`,
    );
    const calls = result.content.filter((block) => block.type === "toolCall");
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (scenario.call) {
      assert.equal(calls.length, 1, `${scenario.name}: expected one call`);
      assert.equal(calls[0].name, scenario.call.name, `${scenario.name}: tool name`);
      assert.deepEqual(calls[0].arguments, scenario.call.arguments, `${scenario.name}: arguments`);
    } else {
      assert.equal(calls.length, 0, `${scenario.name}: removed tool must not be called`);
      assert.equal(text.trim(), scenario.text, `${scenario.name}: active instruction`);
    }
    messages.push(result);
    for (const call of calls) {
      assert.ok(
        scenario.active.includes(call.name),
        "Execution guard rejected an unavailable tool",
      );
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: JSON.stringify(call.arguments) }],
        isError: false,
        timestamp: 0,
      });
    }
    report({
      scenario: scenario.name,
      status: "passed",
      input: result.usage.input,
      output: result.usage.output,
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: { config: { type: "string" }, model: { type: "string" } },
    });
    const env = values.config
      ? { ...process.env, XIAOWEI_LLM_CONFIG: resolve(values.config) }
      : process.env;
    const { document } = await loadConfig(env);
    const selected = values.model ?? document.defaults.modelRef;
    const config = resolveModels(document, env).find((entry) => entry.id === selected);
    assert.ok(config, "Selected model or credential unavailable");
    await verifyContextUpdates(config, { report: (result) => console.log(JSON.stringify(result)) });
  } catch {
    console.error(
      "Context update verification failed; configuration and provider error details suppressed.",
    );
    process.exitCode = 1;
  }
}
