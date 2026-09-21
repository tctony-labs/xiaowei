import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  Database,
  EmptySchema,
  Meta,
  MetaEntrySchema,
  MetaKeySchema,
  MetaPrefixSchema,
  MetaValueSchema,
  SqlStatementSchema,
} from "xiaowei-contracts";
import { bindClient, methodRoute } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachNative } from "xiaowei-gateway/native";

const require = createRequire(import.meta.url);
const { Storage } =
  require("../../../../crates/xiaowei-storage/napi") as typeof import("../../../../crates/xiaowei-storage/napi/index.js");
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
  const owner = await attachNative(host, "storage", storage.createGatewayEndpoint());
  const endpoint = peer.createGatewayFixture();
  const remote = await attachNative(host, "peer", endpoint);
  const client = host.client({ caller: "storage-test", trusted: true });
  const meta = bindClient(Meta, client);
  try {
    await meta.set(create(MetaEntrySchema, { key: "setting.clipboardEnabled", json: "true" }));
    const read = await endpoint.fixtureInvoke(
      JSON.stringify(methodRoute(Meta.method.get)),
      Buffer.from(toBinary(MetaKeySchema, create(MetaKeySchema, { key: "setting.clipboardEnabled" }))),
    );
    assert.ok(Buffer.isBuffer(read), String(read));
    assert.equal(fromBinary(MetaValueSchema, read).json, "true");
    const written = await endpoint.fixtureInvoke(
      JSON.stringify(methodRoute(Meta.method.set)),
      Buffer.from(toBinary(MetaEntrySchema, create(MetaEntrySchema, { key: "setting.%_", json: "null" }))),
    );
    assert.ok(Buffer.isBuffer(written), String(written));
    fromBinary(EmptySchema, written);
    assert.equal((await meta.get(create(MetaKeySchema, { key: "setting.%_" }))).json, "null");
    assert.equal((await meta.get(create(MetaKeySchema, { key: "missing" }))).json, undefined);
    assert.equal((await meta.list(create(MetaPrefixSchema, { prefix: "setting.%_" }))).entries.length, 1);
    await assert.rejects(meta.set(create(MetaEntrySchema, { key: "invalid", json: "not json" })));
    const result = await bindClient(Database, client).query(
      create(SqlStatementSchema, {
        sql: "SELECT key FROM meta WHERE key='setting.clipboardEnabled'",
      }),
    );
    assert.equal(result.rows.length, 1);
  } finally {
    await remote.close();
    await owner.close();
  }
  try {
    const reopened = await Storage.open(path);
    const next = await attachNative(host, "storage", reopened.createGatewayEndpoint());
    try {
      assert.equal((await meta.get(create(MetaKeySchema, { key: "setting.%_" }))).json, "null");
    } finally {
      await next.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
