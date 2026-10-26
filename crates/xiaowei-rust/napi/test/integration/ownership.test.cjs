const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { create } = require("@bufbuild/protobuf");
const {
  ClipboardHistory,
  GatewayEndpoint,
  Storage,
  createSearchGatewayEndpoint,
} = require("../..");

test("merged endpoints share a type and business owners close independently", async () => {
  const { KeyValue, KvEntrySchema, KvKeySchema } = await import("proto-desktop-ts");
  const { bindClient } = await import("xiaowei-gateway");
  const { GatewayHost } = await import("xiaowei-gateway/host");
  const { attachRustNapi } = await import("xiaowei-gateway/rust-napi");
  const directory = await mkdtemp(join(tmpdir(), "xiaowei-merged-owners-"));
  const host = new GatewayHost();
  const owners = [];
  let history;
  try {
    const database = await Storage.open(join(directory, "storage.sqlite"));
    const storage = database.createKeyValueGatewayEndpoint();
    const dao = database.createClipboardDaoGatewayEndpoint();
    const search = createSearchGatewayEndpoint(false);
    for (const [name, endpoint] of [
      ["storage", storage],
      ["dao", dao],
      ["search", search],
    ]) {
      assert.ok(endpoint instanceof GatewayEndpoint);
      owners.push(await attachRustNapi(host, name, endpoint));
    }
    history = await ClipboardHistory.open(directory, () => {});
    const clipboard = history.createGatewayEndpoint();
    assert.ok(clipboard instanceof GatewayEndpoint);
    const owner = await attachRustNapi(host, "clipboard", clipboard);
    owners.push(owner);
    await history.initialize();
    const item = await history.addText("shared addon, separate owners");
    assert.equal(await history.readText(item.id), "shared addon, separate owners");
    await owner.close();
    await owners[2].close();

    const kv = bindClient(KeyValue, host.client({ caller: "ownership-test", trusted: true }));
    await kv.set(
      create(KvEntrySchema, {
        key: "after-close",
        json: JSON.stringify("storage still open"),
      }),
    );
    const saved = await kv.get(create(KvKeySchema, { key: "after-close" }));
    assert.equal(saved.json, JSON.stringify("storage still open"));
  } finally {
    await history?.close();
    for (const owner of owners.reverse()) await owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});
