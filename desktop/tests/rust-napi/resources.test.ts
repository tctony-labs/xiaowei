import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import {
  CaptureClipboardEntityRequestSchema,
  ClipboardBiz,
  ClipboardDao,
  ClipboardItemRequestSchema,
  ClipboardResourceRequestSchema,
  CopyResourcePathRequestSchema,
  EditTextRequestSchema,
  EmptySchema,
  System,
} from "xiaowei-contracts";
import { bindClient, bindHandlers, methodRoute } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachRustNapi } from "xiaowei-gateway/rust-napi";
import type * as ClipboardNative from "../../../crates/xiaowei-clipboard/napi/index.js";
import type * as StorageNative from "../../../crates/xiaowei-storage/napi/index.js";

const require = createRequire(import.meta.url);
const { ClipboardHistory } = require("../../../crates/xiaowei-clipboard/napi") as typeof ClipboardNative;
const { Storage } = require("../../../crates/xiaowei-storage/napi") as typeof StorageNative;

test("Rust clipboard owns resource resolution, exports, permissions and close cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clipboard-resources-"));
  const history = await ClipboardHistory.open(directory, () => {}, directory);
  const host = new GatewayHost();
  const database = await Storage.open(join(directory, "storage.sqlite"));
  const storage = await attachRustNapi(host, "storage", database.createKeyValueGatewayEndpoint());
  const daoOwner = await attachRustNapi(host, "dao", database.createClipboardDaoGatewayEndpoint());
  const owner = await attachRustNapi(host, "clipboard", history.createGatewayEndpoint());
  await history.initialize();

  const paths: string[] = [];
  const texts: string[] = [];
  let fail = false;
  const system = host.registerOwner(
    "system",
    bindHandlers(
      System,
      {
        openPath: (request) => {
          if (fail) throw new Error("Viewer failed");
          paths.push(request.path);
          return create(EmptySchema);
        },
        revealPath: (request) => {
          paths.push(request.path);
          return create(EmptySchema);
        },
        writeClipboardText: (request) => {
          texts.push(request.text);
          return create(EmptySchema);
        },
      },
      { partial: true },
    ),
  );
  const client = host.client({ caller: "resource-test", trusted: true });
  const api = bindClient(ClipboardBiz, client);
  const dao = bindClient(ClipboardDao, client);
  const resource = (id: bigint, index?: number) => create(ClipboardResourceRequestSchema, { id, index });
  let exportDirectory = "";
  try {
    const text = await history.addText("original 中文");
    const id = BigInt(text.id);
    await api.openResource(resource(id));
    const first = paths.at(-1);
    assert.ok(first);
    exportDirectory = dirname(first);
    assert.equal(await readFile(first, "utf8"), "original 中文");
    if (process.platform !== "win32") {
      assert.equal((await stat(first)).mode & 0o777, 0o600);
      assert.equal((await stat(exportDirectory)).mode & 0o777, 0o700);
    }
    await writeFile(first, "external edit");
    await Promise.all([api.openResource(resource(id)), api.openResource(resource(id))]);
    assert.equal(await readFile(first, "utf8"), "original 中文");
    assert.deepEqual(await readdir(exportDirectory), [first.slice(exportDirectory.length + 1)]);

    await api.editText(create(EditTextRequestSchema, { id, text: "updated 中文" }));
    await api.openResource(resource(id));
    assert.notEqual(paths.at(-1), first);
    const editedPath = paths.at(-1);
    assert.ok(editedPath);
    assert.equal(await readFile(editedPath, "utf8"), "updated 中文");
    assert.equal(await readFile(first, "utf8"), "original 中文");
    await api.delete(create(ClipboardItemRequestSchema, { id }));
    assert.equal(await readFile(first, "utf8"), "original 中文");
    await assert.rejects(api.openResource(resource(id)));
    await assert.rejects(api.openResource(resource(0n)));

    const long = await history.addText("long text ".repeat(2000));
    await api.openResource(resource(BigInt(long.id)));
    assert.ok(long.textPath);
    assert.equal(paths.at(-1), long.textPath);
    assert.equal((await readFile(long.textPath, "utf8")).length, 20000);
    await assert.rejects(api.openResource(resource(BigInt(long.id), 0)));

    const imagePath = join(directory, "images", "image-hash.png");
    await writeFile(imagePath, Uint8Array.of(1, 2, 3));
    const image = await dao.capture(
      create(CaptureClipboardEntityRequestSchema, {
        kind: "image",
        hash: "image-hash",
        width: 1,
        height: 1,
        createdAtMs: BigInt(Date.now()),
      }),
    );
    await api.openResource(resource(image.id));
    assert.equal(paths.at(-1), imagePath);

    const files = await dao.capture(
      create(CaptureClipboardEntityRequestSchema, {
        kind: "file",
        hash: "files-hash",
        paths: ["/tmp/a,b.txt", "/tmp/中文.txt", "/other/c.txt"],
        createdAtMs: BigInt(Date.now()),
      }),
    );
    await api.openResource(resource(files.id, 1));
    assert.equal(paths.at(-1), "/tmp/中文.txt");
    await api.revealResource(resource(files.id));
    assert.deepEqual(paths.slice(-3), ["/tmp/a,b.txt", "/tmp/中文.txt", "/other/c.txt"]);
    await api.copyResourcePath(create(CopyResourcePathRequestSchema, { id: files.id, directory: true }));
    assert.equal(texts.at(-1), "/tmp\n/other");
    await api.copyResourcePath(create(CopyResourcePathRequestSchema, { id: files.id, index: 0 }));
    assert.equal(texts.at(-1), "/tmp/a,b.txt");
    await assert.rejects(api.openResource(resource(files.id)));
    await assert.rejects(api.openResource(resource(files.id, 99)));

    const restricted = bindClient(
      ClipboardBiz,
      host.client({
        caller: "restricted",
        trusted: false,
        invoke: [methodRoute(ClipboardBiz.method.openResource).name, methodRoute(ClipboardDao.method.get).name],
      }),
    );
    const count = paths.length;
    await assert.rejects(restricted.openResource(resource(files.id, 0)), /Unauthorized/);
    assert.equal(paths.length, count);
    fail = true;
    await assert.rejects(api.openResource(resource(files.id, 0)));
    assert.equal(paths.length, count);

    await owner.close();
    await assert.rejects(stat(exportDirectory));
    assert.deepEqual([...(await readFile(imagePath))], [1, 2, 3]);
    assert.equal((await readFile(long.textPath, "utf8")).length, 20000);
    await assert.rejects(api.openResource(resource(files.id, 0)));
  } finally {
    await owner.close();
    system.close();
    await daoOwner.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("clipboard initialization can be abandoned without retaining its export directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "clipboard-resource-close-"));
  try {
    const history = await ClipboardHistory.open(join(root, "history"), () => {}, root);
    assert.equal((await readdir(root)).filter((name) => name.startsWith("xiaowei-clipboard-")).length, 1);
    await history.close();
    await history.close();
    assert.deepEqual(await readdir(root), ["history"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
