const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { Storage } = require("..");

test("Storage opens a real file, exports only typed routes and closes idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "storage-native-"));
  try {
    const storage = await Storage.open(join(directory, "storage.sqlite"));
    const endpoint = storage.createKeyValueGatewayEndpoint();
    const manifest = JSON.parse(endpoint.manifest());
    assert.deepEqual(manifest.routes.map((route) => route.name).sort(), [
      "xiaowei.storage.KeyValue.Delete",
      "xiaowei.storage.KeyValue.Get",
      "xiaowei.storage.KeyValue.List",
      "xiaowei.storage.KeyValue.Set",
      "xiaowei.storage.Storage.DatabaseUsage",
    ]);
    assert.ok(Buffer.isBuffer(await endpoint.close()));
    assert.ok(Buffer.isBuffer(await endpoint.close()));
    const invalid = join(directory, "invalid.sqlite");
    await writeFile(invalid, "not sqlite");
    await assert.rejects(Storage.open(invalid));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
