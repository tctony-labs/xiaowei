import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import {
  GetWebSearchRuntimeConfigRequestSchema,
  Settings,
  SettingsChangedSchema,
  UpdateSettingsRequestSchema,
  WebSearchProvider,
} from "proto-desktop-ts";
import { Agent } from "xiaowei-agent";
import { bindClient } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachRustNapi } from "xiaowei-gateway/rust-napi";
import { Storage } from "xiaowei-rust";

test("production Settings and Agent addons share committed redacted settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "xiaowei-agent-settings-"));
  const host = new GatewayHost();
  const database = await Storage.open(join(root, "settings.sqlite"));
  const settingsOwner = await attachRustNapi(
    host,
    "settings",
    database.createSettingsGatewayEndpoint("darwin"),
  );
  const agent = await Agent.open(join(root, "agent"));
  const endpoint = await attachRustNapi(host, "agent", agent.createGatewayEndpoint());
  const client = host.client({ caller: "settings-test", trusted: true });
  const api = bindClient(Settings, client);
  const events: unknown[] = [];
  const subscription = await client.subscribe(
    SettingsChangedSchema.typeName,
    undefined,
    (bytes) => {
      events.push(fromBinary(SettingsChangedSchema, bytes).snapshot?.webSearch);
    },
  );
  try {
    const defaults = (await api.get(create(EmptySchema))).webSearch;
    assert.equal(defaults?.effectiveProvider, WebSearchProvider.BING);
    const selected = await api.update(
      create(UpdateSettingsRequestSchema, {
        change: { case: "webSearchProvider", value: WebSearchProvider.TAVILY },
      }),
    );
    assert.equal(selected.webSearch?.selectedProvider, WebSearchProvider.TAVILY);
    assert.equal(selected.webSearch?.effectiveProvider, WebSearchProvider.BING);
    await assert.rejects(
      api.getWebSearchRuntimeConfig(
        create(GetWebSearchRuntimeConfigRequestSchema, { provider: WebSearchProvider.TAVILY }),
      ),
    );
    for (const apiKey of ["tavily-fixture-a", "tavily-fixture-b"]) {
      await api.update(
        create(UpdateSettingsRequestSchema, {
          change: {
            case: "webSearchApiKey",
            value: { provider: WebSearchProvider.TAVILY, apiKey },
          },
        }),
      );
    }
    const current = await api.getWebSearchRuntimeConfig(
      create(GetWebSearchRuntimeConfigRequestSchema),
    );
    assert.equal(current.provider, WebSearchProvider.TAVILY);
    assert.equal(current.apiKey, "tavily-fixture-b");
    const frame = bindClient(Settings, host.client({ caller: "frame:1:1", trusted: true }));
    await assert.rejects(
      frame.getWebSearchRuntimeConfig(create(GetWebSearchRuntimeConfigRequestSchema)),
      (error: unknown) => (error as { detail: { code: string } }).detail.code === "UNAUTHORIZED",
    );
    assert.ok(!JSON.stringify(await api.get(create(EmptySchema))).includes("fixture"));
    assert.ok(!JSON.stringify(events).includes("fixture"));
    const deleted = await api.update(
      create(UpdateSettingsRequestSchema, {
        change: {
          case: "webSearchApiKey",
          value: { provider: WebSearchProvider.TAVILY, apiKey: "" },
        },
      }),
    );
    assert.equal(deleted.webSearch?.selectedProvider, WebSearchProvider.BING);
  } finally {
    subscription.close();
    await agent.close();
    await endpoint.close();
    await settingsOwner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent activation fails and cleans up when desktop Settings is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "xiaowei-agent-settings-missing-"));
  const host = new GatewayHost();
  const agent = await Agent.open(root);
  try {
    await assert.rejects(attachRustNapi(host, "agent", agent.createGatewayEndpoint()));
  } finally {
    await agent.close();
    await rm(root, { recursive: true, force: true });
  }
});
