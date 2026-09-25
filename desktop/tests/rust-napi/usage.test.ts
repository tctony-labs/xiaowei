import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { ClipboardBiz, ClipboardResourceRequestSchema, EmptySchema, Storage, System } from "xiaowei-contracts";
import { bindClient, bindHandlers, methodRoute } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachRustNapi } from "xiaowei-gateway/rust-napi";
import type * as ClipboardNative from "../../../crates/xiaowei-clipboard/napi/index.js";
import type * as StorageNative from "../../../crates/xiaowei-storage/napi/index.js";

const require = createRequire(import.meta.url);
const { ClipboardHistory } = require("../../../crates/xiaowei-clipboard/napi") as typeof ClipboardNative;
const nativeStorage = require("../../../crates/xiaowei-storage/napi") as typeof StorageNative;

test("clipboard usage combines Storage file sizes with attachments and preserves caller permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "clipboard-usage-"));
  const directory = join(root, "clipboard");
  const databasePath = join(root, "storage.sqlite");
  const database = await nativeStorage.Storage.open(databasePath);
  const history = await ClipboardHistory.open(directory, () => {}, root);
  const host = new GatewayHost();
  const storage = await attachRustNapi(host, "storage", database.createKeyValueGatewayEndpoint());
  const dao = await attachRustNapi(host, "dao", database.createClipboardDaoGatewayEndpoint());
  const clipboard = await attachRustNapi(host, "clipboard", history.createGatewayEndpoint());
  const system = host.registerOwner(
    "system",
    bindHandlers(System, { openPath: () => create(EmptySchema) }, { partial: true }),
  );
  await history.initialize();
  const client = host.client({ caller: "usage-test", trusted: true });
  const api = bindClient(ClipboardBiz, client);
  const storageApi = bindClient(Storage, client);
  try {
    const text = await history.addText("ordinary text exported outside attachments");
    await mkdir(join(directory, "images", "nested"));
    await writeFile(join(directory, "images", "nested", "image.png"), "image");
    await writeFile(join(directory, "large_text", "hash"), "text");
    if (process.platform !== "win32") {
      await symlink(databasePath, join(directory, "database-link"));
      await symlink(directory, join(directory, "recursive-link"));
    }

    const sizes = await Promise.all(
      ["", "-wal", "-shm"].map(async (suffix) => {
        try {
          return (await stat(databasePath + suffix, { bigint: true })).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0n;
          throw error;
        }
      }),
    );
    const total = sizes.reduce((sum, size) => sum + size, 0n);
    assert.ok(total > 0n);
    assert.equal((await storageApi.databaseUsage(create(EmptySchema))).usedBytes, total);
    assert.equal((await api.storageUsage(create(EmptySchema))).usedBytes, total + 9n);

    await api.openResource(create(ClipboardResourceRequestSchema, { id: BigInt(text.id) }));
    assert.equal((await api.storageUsage(create(EmptySchema))).usedBytes, total + 9n);
    await rm(join(directory, "images", "nested", "image.png"));
    assert.equal((await api.storageUsage(create(EmptySchema))).usedBytes, total + 4n);

    const restricted = bindClient(
      ClipboardBiz,
      host.client({
        caller: "restricted",
        trusted: false,
        invoke: [methodRoute(ClipboardBiz.method.storageUsage).name],
      }),
    );
    await assert.rejects(restricted.storageUsage(create(EmptySchema)), /Unauthorized/);
    await storage.close();
    await assert.rejects(api.storageUsage(create(EmptySchema)));
  } finally {
    await clipboard.close();
    system.close();
    await dao.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
