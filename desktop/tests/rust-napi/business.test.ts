import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import {
  ClipboardBiz,
  ClipboardCategoryRequestSchema,
  ClipboardChangedSchema,
  ClipboardDao,
  ClipboardItemRequestSchema,
  ClipboardKind,
  ClipboardListOptionsSchema,
  EditTextRequestSchema,
  EmptySchema,
  FavoriteRequestSchema,
  SaveCategoryRequestSchema,
  Search,
  SearchClipboardEntitiesRequestSchema,
  SearchRequestSchema,
  SetCategoryRequestSchema,
  SetRemarkRequestSchema,
} from "xiaowei-contracts";
import { bindClient, methodRoute } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachNative } from "xiaowei-gateway/native";

const require = createRequire(import.meta.url);
const clipboard =
  require("../../../crates/xiaowei-clipboard/napi") as typeof import("../../../crates/xiaowei-clipboard/napi/index.js");
const search =
  require("../../../crates/xiaowei-search/napi") as typeof import("../../../crates/xiaowei-search/napi/index.js");

test("production clipboard Gateway shares Service, data lifecycle, validation and invalidation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-clipboard-"));
  const history = await clipboard.ClipboardHistory.open(directory, () => {});
  const host = new GatewayHost();
  const { Storage } =
    require("../../../crates/xiaowei-storage/napi") as typeof import("../../../crates/xiaowei-storage/napi/index.js");
  const storage = await Storage.open(join(directory, "storage.sqlite"));
  const storageOwner = await attachNative(host, "storage", storage.createKeyValueGatewayEndpoint());
  const daoOwner = await attachNative(host, "clipboard-dao", storage.createClipboardDaoGatewayEndpoint());
  const owner = await attachNative(host, "clipboard", history.createGatewayEndpoint());
  await history.initialize();
  const client = host.client({ caller: "test", trusted: true });
  const api = bindClient(ClipboardBiz, client);
  const dao = bindClient(ClipboardDao, client);
  let changed = 0;
  const subscription = await client.subscribe(ClipboardChangedSchema.typeName, undefined, () => {
    changed++;
  });
  try {
    await api.list(create(ClipboardListOptionsSchema));
    const added = await history.addText("Gateway临时数据库验证");
    const key = BigInt(added.id);
    const item = (id: bigint) => create(ClipboardItemRequestSchema, { id });
    assert.equal((await api.get(item(key))).item?.previewText, added.text);
    const restricted = bindClient(
      ClipboardBiz,
      host.client({
        caller: "restricted-clipboard",
        trusted: false,
        invoke: [methodRoute(ClipboardBiz.method.get).name],
      }),
    );
    await assert.rejects(restricted.get(item(key)), /Unauthorized/);
    assert.equal((await api.readText(item(key))).text, added.text);
    assert.equal((await api.setFavorite(create(FavoriteRequestSchema, { id: key, favorite: true }))).updated, true);
    assert.equal((await api.setFavorite(create(FavoriteRequestSchema, { id: key, favorite: false }))).updated, true);
    assert.equal((await api.get(item(key))).item?.favorite, false);
    await api.setFavorite(create(FavoriteRequestSchema, { id: key, favorite: true }));
    assert.equal((await api.setFavorite(create(FavoriteRequestSchema, { id: 9223372036854775807n }))).updated, false);
    const longText = "long text ".repeat(10000);
    const long = await history.addText(longText);
    const summary = (await api.get(item(BigInt(long.id)))).item;
    assert.ok(summary);
    assert.equal(summary.kind, ClipboardKind.TEXT);
    assert.equal(summary.previewTruncated, true);
    assert.ok((summary.previewText?.length ?? 0) < longText.length);
    assert.ok(summary.createdAtMs > 1_000_000_000_000n);
    assert.equal((await api.readText(item(BigInt(long.id)))).text, longText);
    await api.delete(item(BigInt(long.id)));
    await assert.rejects(api.list(create(ClipboardListOptionsSchema, { kind: 999 as ClipboardKind })));
    await api.setRemark(create(SetRemarkRequestSchema, { id: key, remark: "note" }));
    const category = await api.saveCategory(create(SaveCategoryRequestSchema, { name: "Work", color: "#123456" }));
    await api.setCategory(create(SetCategoryRequestSchema, { id: key, categoryId: category.id }));
    assert.equal(
      (await api.list(create(ClipboardListOptionsSchema, { categoryId: category.id }))).items[0].remark,
      "note",
    );
    const recalled = await dao.search(create(SearchClipboardEntitiesRequestSchema, { query: "note", limit: 1 }));
    assert.equal(recalled.hits[0].entity?.id, key);
    assert.ok(recalled.hits[0].snippet.includes("note"));
    assert.equal(
      (await api.list(create(ClipboardListOptionsSchema, { query: "验证 no", categoryId: category.id }))).items[0].id,
      key,
    );
    const edited = await api.editText(create(EditTextRequestSchema, { id: key, text: "updated" }));
    assert.equal(edited.previewText, "updated");
    assert.equal((await history.get(String(edited.id)))?.text, "updated");
    await api.setCategory(create(SetCategoryRequestSchema, { id: edited.id }));
    await api.deleteCategory(create(ClipboardCategoryRequestSchema, { id: category.id }));
    assert.deepEqual((await api.categories(create(EmptySchema))).items, []);
    assert.equal((await api.clearHistory(create(EmptySchema))).deletedCount, 0); // Favorite survives.
    assert.equal((await api.delete(item(edited.id))).deleted, true);
    assert.equal((await api.get(item(edited.id))).item, undefined);
    assert.deepEqual((await dao.search(create(SearchClipboardEntitiesRequestSchema, { query: "note" }))).hits, []);
    await assert.rejects(api.readImage(item(edited.id)));
    await assert.rejects(api.list(create(ClipboardListOptionsSchema, { limit: 101 })));
    await assert.rejects(api.get(item(9223372036854775808n)));
    await assert.rejects(api.saveCategory(create(SaveCategoryRequestSchema, { name: "", color: "invalid" })));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(changed > 0);
  } finally {
    subscription.close();
    await history.stopMonitoring();
    await owner.close();
    await daoOwner.close();
    await storageOwner.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("production search endpoint uses generated contract and rejects invalid query before warming engine", async () => {
  const host = new GatewayHost();
  const owner = await attachNative(host, "search", search.createSearchGatewayEndpoint());
  try {
    const client = bindClient(Search, host.client({ caller: "test", trusted: true }));
    assert.deepEqual((await client.query(create(SearchRequestSchema))).hits, []);
    await assert.rejects(client.query(create(SearchRequestSchema, { query: "x".repeat(4097) })), /too long/);
  } finally {
    await owner.close();
  }
});
