import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Llm, SetModelsRequestSchema } from "xiaowei-contracts";
import { bindClient } from "xiaowei-gateway";
import { llmFixture, request, waitFor } from "../fixtures/llm.mjs";

const collect = async (stream) => {
  const events = [];
  for await (const event of stream) events.push(event.event);
  return events;
};

for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
  test(`${api}: replacement and deletion preserve in-flight streams`, async (t) => {
    const fixture = await llmFixture(t, undefined, api);
    const old = await fixture.client.generate(request("paused"));
    assert.equal((await old.next()).value.event.value.text, "你");
    const next = { ...fixture.model, modelId: "new-upstream", apiKey: "new-key" };
    await fixture.owner.updateModels([next]);
    const events = await collect(await fixture.client.generate(request("new")));
    assert.deepEqual(
      events.map((event) => event.case),
      ["textDelta", "textDelta", "usage", "finished"],
    );
    assert.equal(fixture.requests[0].body.model, "text-model");
    assert.equal(fixture.requests[0].auth, "Bearer test-key");
    assert.equal(fixture.requests[1].body.model, "new-upstream");
    assert.equal(fixture.requests[1].auth, "Bearer new-key");
    assert.equal(events[2].value.input, 5n);
    assert.ok(!fixture.disconnected.has("paused"));
    await fixture.owner.updateModels([]);
    await assert.rejects(fixture.client.generate(request("missing")), /unknown model reference/);
    fixture.resume.get("paused")();
    assert.equal((await collect(old)).at(-1).case, "finished");
  });

  test(`${api}: malformed updates are atomic and later updates still work`, async (t) => {
    const fixture = await llmFixture(t, undefined, api);
    const configurations = bindClient(Llm, fixture.host.client({ caller: "test", trusted: true }));
    await assert.rejects(
      configurations.setModels(
        create(SetModelsRequestSchema, {
          models: [{ id: "bad", apiKey: "secret" }],
        }),
      ),
      /invalid LLM model configuration/,
    );
    await assert.rejects(fixture.owner.updateModels([fixture.model, { ...fixture.model, id: "other", maxTokens: -1 }]));
    await collect(await fixture.client.generate(request("after-invalid")));
    assert.equal(fixture.requests[0].body.model, "text-model");
    const one = fixture.owner.updateModels([{ ...fixture.model, modelId: "one" }]);
    const final = { ...fixture.model, modelId: "two" };
    const two = fixture.owner.updateModels([final]);
    final.modelId = "mutated";
    await Promise.all([one, two]);
    await collect(await fixture.client.generate(request()));
    assert.equal(fixture.requests[1].body.model, "two");
    await fixture.owner.close();
    await assert.rejects(fixture.owner.updateModels([]), /closed/);
  });

  test(`${api}: failures and cancellation release HTTP after an update`, async (t) => {
    const fixture = await llmFixture(t, undefined, api);
    for (const text of ["http-error", "truncated"]) {
      const events = await collect(await fixture.client.generate(request(text)));
      assert.equal(events.at(-1).case, "failed");
    }
    const old = await fixture.client.generate(request("cancel"));
    await old.next();
    await fixture.owner.updateModels([{ ...fixture.model, apiKey: "replacement" }]);
    await old.cancel();
    await waitFor(() => fixture.disconnected.has("cancel"));
    assert.equal((await collect(await fixture.client.generate(request()))).at(-1).case, "finished");
  });
}

test("closing during queued updates rejects pending work and aborts existing HTTP", async (t) => {
  const fixture = await llmFixture(t);
  const stream = await fixture.client.generate(request("close"));
  await stream.next();
  const updates = [fixture.owner.updateModels([fixture.model]), fixture.owner.updateModels([])];
  const outcomes = Promise.allSettled(updates);
  await fixture.owner.close();
  assert.ok((await outcomes).every((result) => result.status === "rejected"));
  await waitFor(() => fixture.disconnected.has("close"));
});

test("endpoint replacement sends new requests to the new server while the old stream completes", async (t) => {
  const previous = await llmFixture(t);
  const next = await llmFixture(t);
  const old = await previous.client.generate(request("paused"));
  await old.next();
  await previous.owner.updateModels([{ ...previous.model, baseUrl: next.model.baseUrl }]);
  await collect(await previous.client.generate(request("new-server")));
  assert.equal(previous.requests.length, 1);
  assert.equal(next.requests.length, 1);
  previous.resume.get("paused")();
  assert.equal((await collect(old)).at(-1).case, "finished");
});

test("Anthropic text calls disable thinking without changing the model capability", async (t) => {
  const fixture = await llmFixture(t, undefined, "anthropic-messages");
  await fixture.owner.updateModels([{ ...fixture.model, reasoning: true }]);
  await collect(await fixture.client.generate(request("text-only")));
  const sent = fixture.requests[0];
  assert.equal(new URL(sent.path, "http://localhost").pathname, "/v1/messages");
  assert.deepEqual(sent.body.thinking, { type: "disabled" });
  assert.equal(sent.body.max_tokens, 128);
  assert.equal(sent.body.temperature, 0.4);
});

for (const api of ["openai-completions", "openai-responses"]) {
  test(`${api}: raw and simple calls preserve model sampling defaults and request overrides`, async (t) => {
    const fixture = await llmFixture(t, undefined, api);
    await fixture.owner.updateModels([{ ...fixture.model, samplingParams: { top_p: 0.25, seed: 17 } }]);
    for (const apiOptionsJson of [undefined, "{}", '{"toolChoice":"auto"}']) {
      for (const samplingParamsJson of [undefined, '{"top_p":0.75}']) {
        await collect(
          await fixture.client.generate(
            request("正常", {
              options: { apiOptionsJson, samplingParamsJson },
            }),
          ),
        );
        const body = fixture.requests.at(-1).body;
        assert.equal(body.top_p, samplingParamsJson ? 0.75 : 0.25);
        assert.equal(body.seed, 17);
      }
    }
    await collect(await fixture.client.generate(request("正常")));
    assert.equal(fixture.requests.at(-1).body.top_p, 0.25);
  });
}

test("invalid nested compatibility is rejected atomically by both host and worker", async (t) => {
  const fixture = await llmFixture(t, undefined, "anthropic-messages");
  const configurations = bindClient(Llm, fixture.host.client({ caller: "test", trusted: true }));
  const { encodeModels } = await import("../../src/main/services/llm/shared/configuration-codec.ts");
  const invalidArgument = (error) => error.detail?.code === "INVALID_ARGUMENT";
  for (const compat of [
    { allowedFallbackModels: [null] },
    { allowedFallbackModels: [{ provider: "p", model: "m", cost: { input: -1 } }] },
    { chatTemplateKwargs: { thinking: { $var: "unknown" } } },
    { openRouterRouting: { only: "invalid" } },
    { vercelGatewayRouting: { order: [null] } },
  ]) {
    const replacement = { ...fixture.model, modelId: "must-not-commit" };
    await assert.rejects(
      fixture.owner.updateModels([replacement, { ...fixture.model, id: "invalid", compat }]),
      invalidArgument,
    );

    // Bypass host validation to exercise the actual worker's decoded PB boundary.
    const input = encodeModels([replacement, { ...fixture.model, id: "invalid" }]);
    input.models[1].compatJson = JSON.stringify(compat);
    await assert.rejects(configurations.setModels(input), invalidArgument);
    assert.equal((await collect(await fixture.client.generate(request("正常")))).at(-1).case, "finished");
    assert.equal(fixture.requests.at(-1).body.model, fixture.model.modelId);
    await assert.rejects(fixture.client.generate(request("正常", { modelRef: "invalid" })), /unknown model/);
  }
  await fixture.owner.updateModels([fixture.model]);
});
