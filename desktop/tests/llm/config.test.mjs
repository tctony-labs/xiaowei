import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, normalizeConfig, resolveModels as resolveDocument } from "../../src/main/services/llm/config.ts";
import { decodeModels, encodeModels } from "../../src/main/services/llm/shared/configuration-codec.ts";
import { configDocument } from "../fixtures/model-config.mjs";

const resolveModels = (models, env) => resolveDocument(normalizeConfig(configDocument(models)), env);

import { toPiModel } from "../../src/main/services/llm/worker/provider.ts";

const model = {
  id: "local",
  name: "Test",
  modelId: "upstream/model",
  api: "openai-completions",
  provider: "deepseek",
  baseUrl: "https://example.com/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 8192,
  maxTokens: 4096,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
  compat: { maxTokensField: "max_tokens" },
  thinkingLevelMap: { off: null },
  apiKeyEnv: "TEST_KEY",
  apiKey: "inline-secret",
};

const invalid = (error) => error.detail?.code === "INVALID_ARGUMENT" && !String(error).includes("secret");

test("configuration resolves credentials and preserves independent model snapshots through protobuf and Pi", () => {
  const [entry] = resolveModels([model], { TEST_KEY: "environment-secret" });
  assert.equal(entry.apiKey, "environment-secret");
  assert.ok(!("apiKeyEnv" in entry));
  assert.equal(resolveModels([model], { TEST_KEY: " " })[0].apiKey, "inline-secret");
  const decoded = decodeModels(encodeModels([entry]).models).get("local");
  assert.equal(decoded.apiKey, entry.apiKey);
  const pi = toPiModel(decoded);
  assert.equal(pi.id, "upstream/model");
  assert.equal(pi.provider, "deepseek");
  assert.equal(pi.compat.maxTokensField, "max_tokens");
  assert.ok(!("apiKey" in pi));
  entry.cost.input = 99;
  entry.compat.maxTokensField = "max_completion_tokens";
  assert.equal(decoded.cost.input, 1);
  assert.equal(pi.compat.maxTokensField, "max_tokens");
});

test("invalid configurations fail without exposing credentials", () => {
  for (const change of [
    { apiKey: undefined, apiKeyEnv: undefined },
    { id: "" },
    { api: "unknown" },
    { contextWindow: 1 },
    { maxTokens: 0 },
    { baseUrl: "invalid-secret" },
    { baseUrl: "https://host/?key=secret" },
    { compat: { unknown: true } },
    { reasoning: "false" },
    { input: ["audio"] },
    { cost: { input: -1 } },
    { thinkingLevelMap: { high: 42 } },
  ])
    assert.throws(() => resolveModels([{ ...model, ...change }], {}), invalid);
  assert.throws(() => resolveModels([model, model], {}), invalid);
});

test("startup loads the versioned file and rejects legacy or malformed input", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "llm-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "models.json");
  assert.deepEqual((await loadConfig({}, path)).document.providers, []);
  for (const value of ["", "relative.json", path]) {
    await assert.rejects(loadConfig({ XIAOWEI_LLM_CONFIG: value }));
  }
  for (const input of ['{"secret":', JSON.stringify({ models: [model] })]) {
    await writeFile(path, input);
    await assert.rejects(loadConfig({ XIAOWEI_LLM_CONFIG: path }), invalid);
  }
  await writeFile(path, JSON.stringify(configDocument([model])));
  const { document } = await loadConfig({ XIAOWEI_LLM_CONFIG: path });
  assert.equal(resolveDocument(document, { TEST_KEY: "file-secret" })[0].apiKey, "file-secret");
});

test("every configured API has a public lazy Pi adapter", async () => {
  const { apis } = await import("../../src/main/services/llm/worker/apis.ts");
  const { modelApis } = await import("../../src/main/services/llm/shared/models.ts");
  assert.deepEqual(Object.keys(apis).sort(), [...modelApis].sort());
  for (const api of modelApis) {
    assert.equal(typeof apis[api]().stream, "function");
    await import(`@earendil-works/pi-ai/api/${api}`);
  }
});

test("model headers, sampling, cost tiers and compatibility survive configuration snapshots", () => {
  const [entry] = resolveModels(
    [
      {
        ...model,
        headers: { "x-provider-option": "enabled" },
        samplingParams: { top_p: 0.8, stop: ["end"] },
        compat: {
          chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } },
          openRouterRouting: { only: ["provider"], max_price: { prompt: 1 } },
          requiresReasoningContentOnAssistantMessages: true,
        },
        cost: { ...model.cost, tiers: [{ inputTokensAbove: 1000, input: 2, output: 3, cacheRead: 1, cacheWrite: 2 }] },
      },
    ],
    {},
  );
  const decoded = decodeModels(encodeModels([entry]).models).get(model.id);
  const pi = toPiModel(decoded);
  assert.deepEqual(pi.headers, entry.headers);
  assert.deepEqual(pi.samplingParams, entry.samplingParams);
  assert.deepEqual(pi.compat, entry.compat);
  assert.deepEqual(pi.cost, entry.cost);
  entry.samplingParams.stop.push("changed");
  assert.deepEqual(pi.samplingParams.stop, ["end"]);

  const cyclic = {};
  cyclic.self = cyclic;
  for (const samplingParams of [{ value: () => 1 }, { value: NaN }, { value: new Map() }, cyclic]) {
    assert.throws(() => resolveModels([{ ...model, samplingParams }], {}), invalid);
  }
});

test("nested compatibility rejects malformed fallback, routing and template values", () => {
  for (const compat of [
    { allowedFallbackModels: [null] },
    { allowedFallbackModels: [{ provider: "p", model: "m" }] },
    { allowedFallbackModels: [{ provider: "", model: "m", cost: model.cost }] },
    { allowedFallbackModels: [{ provider: "p", model: "m", cost: { ...model.cost, output: -1 } }] },
    { allowedFallbackModels: [{ provider: "p", model: "m", cost: { ...model.cost, tiers: [null] } }] },
    { chatTemplateKwargs: { thinking: [] } },
    { chatTemplateArgs: { thinking: { $var: "unknown" } } },
    { chatTemplateKwargs: { thinking: { $var: "thinking.enabled", omitWhenOff: "yes" } } },
    { openRouterRouting: { only: [null] } },
    { openRouterRouting: { allow_fallbacks: "yes" } },
    { openRouterRouting: { data_collection: "unknown" } },
    { openRouterRouting: { sort: { partition: 1 } } },
    { openRouterRouting: { max_price: { prompt: null } } },
    { openRouterRouting: { preferred_min_throughput: { p50: "fast" } } },
    { openRouterRouting: { preferred_max_latency: { p100: 1 } } },
    { vercelGatewayRouting: { order: "provider" } },
    { vercelGatewayRouting: { unknown: true } },
  ])
    assert.throws(() => resolveModels([{ ...model, compat }], {}), invalid);
});

test("complete nested compatibility survives protobuf and independent snapshots", () => {
  const compat = {
    allowedFallbackModels: [{ provider: "p", model: "m", cost: { ...model.cost } }],
    chatTemplateKwargs: {
      enabled: { $var: "thinking.enabled", omitWhenOff: true },
      effort: { $var: "thinking.effort" },
      budget: { $var: "thinking.budget" },
      number: 1,
      string: "literal",
      bool: false,
      nil: null,
    },
    chatTemplateArgs: { enabled: true },
    vercelGatewayRouting: { only: ["p"], order: ["p"] },
    openRouterRouting: {
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
      zdr: true,
      enforce_distillable_text: false,
      order: ["p"],
      only: ["p"],
      ignore: [],
      quantizations: ["fp16"],
      sort: { by: "price", partition: null },
      max_price: { prompt: "0.1", completion: 1 },
      preferred_min_throughput: { p50: 10, p75: 8, p90: 5, p99: 1 },
      preferred_max_latency: 2,
    },
  };
  const [entry] = resolveModels([{ ...model, compat }], {});
  const decoded = decodeModels(encodeModels([entry]).models).get(model.id);
  assert.deepEqual(decoded.compat, compat);
  compat.allowedFallbackModels[0].cost.input = 99;
  compat.openRouterRouting.only.push("changed");
  assert.equal(decoded.compat.allowedFallbackModels[0].cost.input, 1);
  assert.deepEqual(decoded.compat.openRouterRouting.only, ["p"]);
});
