import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { GenerateRequestSchema } from "xiaowei-contracts";
import { toOptions } from "../../src/main/services/llm/worker/options.ts";

const model = { api: "openai-completions", maxTokens: 32768, reasoning: true };
const options = (input, config = model) => toOptions(create(GenerateRequestSchema, input), config);

test("generation options use model budget and preserve common sampling and reasoning", () => {
  assert.equal(options({}).options.maxTokens, 32768);
  const result = options({
    options: {
      reasoning: "high",
      thinkingBudgetsJson: '{"high":4096}',
      toolChoiceJson: '"auto"',
      samplingParamsJson: '{"top_p":0.9}',
      metadataJson: '{"trace":"test"}',
      cacheRetention: "long",
      transport: "sse",
      sessionId: "session",
      timeoutMs: 1000,
    },
  });
  assert.equal(result.simple, true);
  assert.equal(result.options.reasoning, "high");
  assert.deepEqual(result.options.thinkingBudgets, { high: 4096 });
  assert.deepEqual(result.options.samplingParams, { top_p: 0.9 });
  assert.equal(result.options.timeoutMs, 1000);
});

test("raw options are protocol specific and cannot replace service credentials or callbacks", () => {
  for (const [api, extra] of [
    ["openai-completions", { toolChoice: "required", reasoningEffort: "high" }],
    ["openai-responses", { reasoningSummary: "detailed", serviceTier: "auto" }],
    ["anthropic-messages", { thinkingEnabled: true, thinkingBudgetTokens: 1024 }],
    ["google-generative-ai", { thinking: { enabled: true, budgetTokens: 1024 } }],
  ]) {
    const result = options({ options: { apiOptionsJson: JSON.stringify(extra) } }, { ...model, api });
    assert.equal(result.simple, false);
    for (const [key, value] of Object.entries(extra)) assert.deepEqual(result.options[key], value);
  }
  for (const input of [
    { maxTokens: 32769 },
    { temperature: Number.NaN },
    { options: { apiOptionsJson: '{"apiKey":"secret"}' } },
    { options: { apiOptionsJson: '{"thinkingEnabled":true}' } },
    { options: { apiOptionsJson: "{}", reasoning: "high" } },
    { options: { apiOptionsJson: '{"reasoningEffort":42}' } },
    { options: { toolChoiceJson: '"required"' } },
    { options: { thinkingBudgetsJson: '{"high":-1}' } },
    { options: { samplingParamsJson: "[]" } },
    { options: { timeoutMs: 0 } },
  ])
    assert.throws(
      () => options(input),
      (error) => error.detail?.code === "INVALID_ARGUMENT",
    );
});
