import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
  DeleteProviderRequestSchema,
  EmptySchema,
  ModelSettings,
  ModelSettingsSnapshotSchema,
  SaveProviderRequestSchema,
  UpdateModelDefaultsRequestSchema,
} from "xiaowei-contracts";
import { bindClient } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { emptyConfig, loadConfig, resolveModels } from "../../src/main/services/llm/config.ts";
import { registerModelSettings } from "../../src/main/services/llm/gateway.ts";

const clear = { operation: { case: "clear", value: {} } };
const preserve = { operation: { case: "preserve", value: {} } };
const key = { operation: { case: "replace", value: "inline-secret" } };
const provider = (name = "Provider") => ({
  name,
  provider: "custom",
  api: "openai-completions",
  baseUrl: "https://example.com/v1",
  transport: "http",
  models: [{ modelId: "upstream", name: "", reasoning: false }],
});

async function fixture(t, env = {}, persist) {
  const directory = await mkdtemp(join(tmpdir(), "model-settings-"));
  const host = new GatewayHost();
  const applied = [];
  let fail = false;
  const path = join(directory, "models.json");
  const owner = registerModelSettings(
    host,
    { path, document: emptyConfig() },
    async (models) => {
      if (fail) throw new Error("secret worker diagnostic");
      applied.push(models);
    },
    env,
    persist,
  );
  t.after(async () => {
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  });
  const api = bindClient(ModelSettings, host.client({ caller: "test", trusted: true }));
  return {
    api,
    path,
    applied,
    owner,
    setFailure: (value) => {
      fail = value;
    },
  };
}

const save = (api, revision, value, credential = key) =>
  api.saveProvider(
    create(SaveProviderRequestSchema, {
      expectedRevision: revision,
      provider: value,
      key: credential,
    }),
  );

test("save assigns stable IDs, defaults and readable JSON, edits preserve keys and references", async (t) => {
  const f = await fixture(t, { TEST_KEY: "environment-secret" });
  const first = await save(f.api, 1n, { ...provider(), apiKeyEnv: "TEST_KEY" });
  const saved = first.providers[0];
  assert.ok(saved.id);
  assert.ok(saved.models[0].id);
  assert.equal(saved.models[0].contextWindow, 131072);
  assert.equal(saved.models[0].maxTokens, 16384);
  assert.equal(f.applied[0][0].apiKey, "environment-secret");
  assert.ok(!toJsonString(ModelSettingsSnapshotSchema, first).includes("secret"));
  const file = await readFile(f.path, "utf8");
  assert.ok(file.includes('\n  "version": 1,\n'));
  assert.ok(file.endsWith("\n"));
  const selected = await f.api.updateDefaults(
    create(UpdateModelDefaultsRequestSchema, {
      expectedRevision: first.revision,
      defaults: { modelRef: saved.models[0].id, smallTextModelRef: saved.models[0].id },
    }),
  );
  assert.equal(f.applied.length, 1);
  const edited = await save(
    f.api,
    selected.revision,
    {
      ...saved,
      name: "Renamed",
      models: [{ ...saved.models[0], modelId: "new-upstream", name: "Friendly" }],
    },
    preserve,
  );
  assert.equal(edited.providers[0].id, saved.id);
  assert.equal(edited.providers[0].models[0].id, saved.models[0].id);
  assert.equal(edited.defaults.modelRef, saved.models[0].id);
  assert.equal(f.applied.at(-1)[0].modelId, "new-upstream");
  const loaded = await loadConfig({}, f.path);
  assert.equal(resolveModels(loaded.document, {})[0].apiKey, "inline-secret");
  const deleted = await f.api.deleteProvider(
    create(DeleteProviderRequestSchema, {
      expectedRevision: edited.revision,
      providerId: saved.id,
    }),
  );
  assert.equal(deleted.defaults.modelRef, "");
  assert.equal(deleted.defaults.smallTextModelRef, "");
  assert.deepEqual(f.applied.at(-1), []);
});

test("missing environment credentials save without invalid worker updates; clear and fallback work", async (t) => {
  const f = await fixture(t);
  const first = await save(f.api, 1n, { ...provider(), apiKeyEnv: "MISSING" }, clear);
  assert.ok(first.providers[0].unavailableReason);
  assert.equal(first.applicationError, "");
  assert.equal(f.applied.length, 0);
  const second = await save(f.api, first.revision, first.providers[0]);
  assert.equal(second.providers[0].unavailableReason, "");
  assert.equal(f.applied.at(-1)[0].apiKey, "inline-secret");
  const third = await save(f.api, second.revision, second.providers[0], clear);
  assert.deepEqual(f.applied.at(-1), []);
  assert.ok(third.providers[0].unavailableReason);
  await assert.rejects(save(f.api, third.revision, { ...third.providers[0], apiKeyEnv: "" }, clear));
});

test("duplicate names/IDs and stale edits fail; same upstream model in different providers is valid", async (t) => {
  const f = await fixture(t);
  const first = await save(f.api, 1n, provider());
  for (const value of [
    provider(),
    { ...provider("Other"), models: [{ modelId: "same" }, { modelId: "same" }] },
    { ...provider("Other"), models: first.providers[0].models },
  ]) {
    await assert.rejects(save(f.api, first.revision, value));
  }
  const second = await save(f.api, first.revision, provider("Other"));
  assert.notEqual(second.providers[0].models[0].id, second.providers[1].models[0].id);
  await assert.rejects(save(f.api, first.revision, provider("Stale")), (error) => error.detail.code === "CONFLICT");
  const a = save(f.api, second.revision, provider("A"));
  const b = save(f.api, second.revision, provider("B"));
  const results = await Promise.allSettled([a, b]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
});

test("file failure leaves old state; worker failure preserves file and reapply uses latest snapshot", async (t) => {
  const failedFile = await fixture(t, {}, async () => {
    throw new Error("disk failure");
  });
  await assert.rejects(save(failedFile.api, 1n, provider()));
  assert.equal((await failedFile.api.get(create(EmptySchema))).revision, 1n);
  assert.equal(failedFile.applied.length, 0);
  const f = await fixture(t);
  f.setFailure(true);
  const first = await save(f.api, 1n, provider());
  assert.ok(first.applicationError);
  assert.equal(first.appliedRevision, 1n);
  assert.equal((await loadConfig({}, f.path)).document.providers.length, 1);
  const second = await save(f.api, first.revision, { ...first.providers[0], name: "Latest" }, preserve);
  f.setFailure(false);
  const applied = await f.api.reapply(create(EmptySchema));
  assert.equal(applied.appliedRevision, second.revision);
  assert.equal(applied.applicationError, "");
  assert.equal(applied.providers[0].name, "Latest");
});

test("unmatched thinking map is disabled, chosen maps survive and clear when disabled", async (t) => {
  const f = await fixture(t);
  const p = provider();
  p.models[0] = { ...p.models[0], reasoning: true, thinkingLevelMapJson: '{"high":"custom"}' };
  const first = await save(f.api, 1n, p);
  assert.equal(first.providers[0].models[0].reasoning, false);
  assert.equal(first.providers[0].models[0].thinkingLevelMapJson, undefined);
  const map = { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
  const next = first.providers[0];
  next.models[0] = { ...next.models[0], reasoning: true, thinkingLevelMapJson: JSON.stringify(map) };
  const second = await save(f.api, first.revision, next, preserve);
  assert.deepEqual(JSON.parse(second.providers[0].models[0].thinkingLevelMapJson), map);
});

test("draft discovery goes through the built worker without saving and cancellation closes HTTP", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { bindStreamClient } = await import("xiaowei-gateway");
  const { DiscoverModelsRequestSchema } = await import("xiaowei-contracts");
  const { attachLlm } = await import("../../src/main/services/llm/host.ts");
  let closed;
  let pending;
  let auth;
  const disconnected = new Promise((resolve) => {
    closed = resolve;
  });
  const started = new Promise((resolve) => {
    pending = resolve;
  });
  const server = createServer((request, response) => {
    auth = request.headers.authorization;
    if (request.url.startsWith("/slow")) {
      response.on("close", closed);
      pending();
    } else {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "discovered", name: "Readable" }] }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const directory = await mkdtemp(join(tmpdir(), "draft-catalog-"));
  const host = new GatewayHost();
  const worker = await attachLlm(host, [], new URL("../../out/main/llm-worker.js", import.meta.url));
  const applied = [];
  const owner = registerModelSettings(
    host,
    { path: join(directory, "models.json"), document: emptyConfig() },
    async (models) => {
      applied.push(models);
      await worker.updateModels(models);
    },
    {},
  );
  t.after(async () => {
    await owner.close();
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  });
  const endpoint = host.client({ caller: "draft", trusted: true });
  const api = bindStreamClient(ModelSettings, endpoint);
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (baseUrl) =>
    create(DiscoverModelsRequestSchema, {
      provider: { ...provider(), baseUrl, models: [] },
      key,
    });
  const stream = await api.listModels(request(base));
  const pages = [];
  for await (const page of stream) pages.push(page);
  assert.equal(pages[0].models[0].modelId, "discovered");
  assert.equal(auth, "Bearer inline-secret");
  assert.equal(applied.length, 0);
  const slow = await api.listModels(request(`${base}/slow`));
  const next = slow.next();
  const rejected = assert.rejects(next);
  await started;
  await slow.cancel();
  await rejected;
  await disconnected;
});
