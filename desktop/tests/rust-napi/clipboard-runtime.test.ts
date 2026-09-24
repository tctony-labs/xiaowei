import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  CaptureClipboardEntityRequestSchema,
  ClipboardDao,
  ClipboardItemRequestSchema,
  EmptySchema,
  FavoriteRequestSchema,
  Settings,
  SettingsChangedSchema,
  SettingsSnapshotSchema,
} from "xiaowei-contracts";
import { bindClient, bindEvent, bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { attachNative } from "xiaowei-gateway/native";
import type * as ClipboardNative from "../../../crates/xiaowei-clipboard/napi/index.js";
import type * as StorageNative from "../../../crates/xiaowei-storage/napi/index.js";

const require = createRequire(import.meta.url);
const { ClipboardHistory } = require("../../../crates/xiaowei-clipboard/napi") as typeof ClipboardNative;
const { Storage } = require("../../../crates/xiaowei-storage/napi") as typeof StorageNative;

test("Rust runtime cleans on retention changes, protects permanent records and stops on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clipboard-runtime-"));
  const host = new GatewayHost();
  const db = await Storage.open(join(directory, "db.sqlite"));
  const daoOwner = await attachNative(host, "dao", db.createClipboardDaoGatewayEndpoint());
  const storageOwner = await attachNative(host, "storage", db.createKeyValueGatewayEndpoint());
  let snapshot = create(SettingsSnapshotSchema, { clipboardEnabled: false, clipboardRetentionDays: -1 });
  const settings = host.registerOwner(
    "settings",
    bindHandlers(
      Settings,
      {
        get: () => snapshot,
      },
      { partial: true },
    ),
    [bindEvent(SettingsChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const history = await ClipboardHistory.open(join(directory, "clipboard"), () => {}, directory);
  const clipboard = await attachNative(host, "clipboard", history.createGatewayEndpoint());
  const dao = bindClient(ClipboardDao, host.client({ caller: "test", trusted: true }));
  const capture = (hash: string) =>
    dao.capture(
      create(CaptureClipboardEntityRequestSchema, {
        hash,
        kind: "text",
        text: hash,
        createdAtMs: 1n,
      }),
    );
  const update = (days: number) => {
    snapshot = create(SettingsSnapshotSchema, { ...snapshot, clipboardRetentionDays: days });
    settings.publish(
      SettingsChangedSchema.typeName,
      toBinary(SettingsChangedSchema, create(SettingsChangedSchema, { snapshot })),
    );
  };
  try {
    await history.initialize();
    await history.startServices();
    await history.startServices();
    const old = await capture("expired");
    const favorite = await capture("favorite");
    await dao.setFavorite(create(FavoriteRequestSchema, { id: favorite.id, favorite: true }));
    update(1);
    await waitFor(async () => !(await dao.get(create(ClipboardItemRequestSchema, { id: old.id }))).entity);
    assert.ok((await dao.get(create(ClipboardItemRequestSchema, { id: favorite.id }))).entity);
    update(-1);
    const permanent = await capture("permanent");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok((await dao.get(create(ClipboardItemRequestSchema, { id: permanent.id }))).entity);
    await clipboard.close();
    update(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok((await dao.get(create(ClipboardItemRequestSchema, { id: permanent.id }))).entity);
    await assert.rejects(history.startServices(), /closed|unavailable/i);
  } finally {
    await clipboard.close();
    await history.close();
    settings.close();
    await daoOwner.close();
    await storageOwner.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for Rust retention cleanup");
}
