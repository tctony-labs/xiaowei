import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  EmptySchema,
  KeyValue,
  KvEntrySchema,
  KvKeySchema,
  KvPrefixSchema,
  KvValueSchema,
  Settings,
  SettingsChangedSchema,
  ShortcutConfigurationSchema,
  Shortcuts,
  System,
  UpdateSettingsRequestSchema,
} from "xiaowei-contracts";
import { bindClient, bindHandlers, GatewayFailure, methodRoute } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachNative } from "xiaowei-gateway/native";

import type * as StorageNative from "../../../../crates/xiaowei-storage/napi/index.js";

const require = createRequire(import.meta.url);
const storageNative = require("../../../../crates/xiaowei-storage/napi") as typeof StorageNative;
const { Storage } = storageNative;
const peer = require("../../../tests/native/search") as {
  createGatewayFixture(): import("xiaowei-gateway/native").NativeEndpoint & {
    fixtureInvoke(route: string, payload: Buffer): Promise<Buffer | string>;
  };
};

test("TS and another Rust addon share Storage, JSON null and persisted settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-storage-"));
  const path = join(directory, "storage.sqlite");
  const host = new GatewayHost();
  const storage = await Storage.open(path);
  const owner = await attachNative(host, "storage", storage.createKeyValueGatewayEndpoint());
  const endpoint = peer.createGatewayFixture();
  const remote = await attachNative(host, "peer", endpoint);
  const client = host.client({ caller: "storage-test", trusted: true });
  const meta = bindClient(KeyValue, client);
  try {
    await meta.set(create(KvEntrySchema, { key: "test.clipboardEnabled", json: "true" }));
    const read = await endpoint.fixtureInvoke(
      JSON.stringify(methodRoute(KeyValue.method.get)),
      Buffer.from(toBinary(KvKeySchema, create(KvKeySchema, { key: "test.clipboardEnabled" }))),
    );
    assert.ok(Buffer.isBuffer(read), String(read));
    assert.equal(fromBinary(KvValueSchema, read).json, "true");
    const written = await endpoint.fixtureInvoke(
      JSON.stringify(methodRoute(KeyValue.method.set)),
      Buffer.from(toBinary(KvEntrySchema, create(KvEntrySchema, { key: "test.%_", json: "null" }))),
    );
    assert.ok(Buffer.isBuffer(written), String(written));
    fromBinary(EmptySchema, written);
    assert.equal((await meta.get(create(KvKeySchema, { key: "test.%_" }))).json, "null");
    assert.equal((await meta.get(create(KvKeySchema, { key: "missing" }))).json, undefined);
    assert.equal((await meta.list(create(KvPrefixSchema, { prefix: "test.%_" }))).entries.length, 1);
    await assert.rejects(
      meta.set(create(KvEntrySchema, { key: "setting.clipboardAutoPaste", json: "true" })),
      (error: unknown) => error instanceof GatewayFailure && error.detail.code === "INVALID_ARGUMENT",
    );
    assert.equal((await meta.list(create(KvPrefixSchema, { prefix: "" }))).entries.length, 2);
    await assert.rejects(meta.set(create(KvEntrySchema, { key: "invalid", json: "not json" })));
  } finally {
    await remote.close();
    await owner.close();
  }
  try {
    const reopened = await Storage.open(path);
    const next = await attachNative(host, "storage", reopened.createKeyValueGatewayEndpoint());
    try {
      assert.equal((await meta.get(create(KvKeySchema, { key: "test.%_" }))).json, "null");
    } finally {
      await next.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Rust Settings owns typed updates and publishes committed snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-settings-"));
  const host = new GatewayHost();
  const storage = await Storage.open(join(directory, "storage.sqlite"));
  const storageOwner = await attachNative(host, "storage", storage.createKeyValueGatewayEndpoint());
  const settingsOwner = await attachNative(host, "settings", storage.createSettingsGatewayEndpoint("darwin"));
  const client = host.client({ caller: "settings-test", trusted: true });
  const settings = bindClient(Settings, client);
  let resolveChanged!: (value: boolean) => void;
  const changed = new Promise<boolean>((resolve) => {
    resolveChanged = resolve;
  });
  const subscription = await client.subscribe(SettingsChangedSchema.typeName, undefined, (bytes) => {
    resolveChanged(fromBinary(SettingsChangedSchema, bytes).snapshot?.clipboardAutoPaste ?? false);
  });
  try {
    assert.equal((await settings.get(create(EmptySchema))).clipboardAutoPaste, false);
    await assert.rejects(
      settings.update(create(UpdateSettingsRequestSchema, { change: { case: "clipboardRetentionDays", value: 5 } })),
      (error: unknown) => error instanceof GatewayFailure && error.detail.code === "INVALID_ARGUMENT",
    );
    const next = await settings.update(
      create(UpdateSettingsRequestSchema, { change: { case: "clipboardAutoPaste", value: true } }),
    );
    assert.equal(next.clipboardAutoPaste, true);
    assert.equal(await changed, true);
    assert.equal((await settings.get(create(EmptySchema))).clipboardAutoPaste, true);
    assert.equal((await settings.get(create(EmptySchema))).clipboardAutoPaste, true);
  } finally {
    subscription.close();
    await settingsOwner.close();
    await storageOwner.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Settings preserves permissions and rolls back failed host operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "settings-effects-"));
  const host = new GatewayHost();
  const database = await Storage.open(join(directory, "db.sqlite"));
  const storage = await attachNative(host, "storage", database.createKeyValueGatewayEndpoint());
  const owner = await attachNative(host, "settings", database.createSettingsGatewayEndpoint("darwin"));
  const applied: boolean[] = [];
  const system = host.registerOwner(
    "system",
    bindHandlers(
      System,
      {
        setAutostart(request) {
          applied.push(request.enabled);
          if (request.enabled) throw new Error("OS refused startup");
          return create(EmptySchema);
        },
      },
      { partial: true },
    ),
  );
  let shortcuts = 0;
  const shortcutOwner = host.registerOwner(
    "shortcuts",
    bindHandlers(Shortcuts, {
      apply() {
        shortcuts++;
        return create(EmptySchema);
      },
    }),
  );
  const api = bindClient(Settings, host.client({ caller: "settings-effects-test", trusted: true }));
  try {
    await assert.rejects(
      api.update(
        create(UpdateSettingsRequestSchema, {
          change: { case: "autostart", value: true },
        }),
      ),
      /HandlerError/,
    );
    assert.deepEqual(applied, [true, false]);
    assert.equal((await api.get(create(EmptySchema))).autostart, false);
    await api.update(
      create(UpdateSettingsRequestSchema, {
        change: { case: "shortcuts", value: create(ShortcutConfigurationSchema) },
      }),
    );
    assert.equal(shortcuts, 1);
    const denied = bindClient(
      Settings,
      host.client({
        caller: "denied",
        trusted: false,
        invoke: [methodRoute(Settings.method.update).name],
      }),
    );
    await assert.rejects(
      denied.update(
        create(UpdateSettingsRequestSchema, {
          change: { case: "autostart", value: true },
        }),
      ),
      /authoriz/i,
    );
    assert.deepEqual(applied, [true, false]);
  } finally {
    await owner.close();
    system.close();
    shortcutOwner.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
