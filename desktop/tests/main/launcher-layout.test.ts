import assert from "node:assert/strict";
import { test } from "node:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import type { BrowserWindow } from "electron";
import {
  Launcher,
  LauncherMode,
  LauncherPinStateSchema,
  UpdateLayoutRequestSchema,
} from "proto-desktop-ts";
import { bindClient } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { registerSearch } from "../../src/main/services/launcher/gateway";

test("Launcher host applies mode-specific heights and window pin state", async () => {
  const sizes: number[][] = [];
  const modes: string[] = [];
  let pinned = false;
  const window = {
    webContents: {},
    setSize: (...size: number[]) => sizes.push(size),
  } as unknown as BrowserWindow;
  const host = new GatewayHost();
  const owner = registerSearch(host, () => window, {
    development: false,
    platform: process.platform,
    async openExternal() {},
    async dismiss() {},
    windowGeneration: () => 0,
    writeText() {},
    async restart() {},
    resetPosition() {},
    iconUrl: () => "",
    includeChromeBookmarks: async () => false,
    modeChanged: (mode) => {
      modes.push(mode);
    },
    pinState(target, next = pinned) {
      assert.equal(target, window);
      if (pinned !== next) {
        pinned = next;
        owner.pinChanged(target, pinned);
      }
      return pinned;
    },
  });
  const client = host.client({ caller: "test", trusted: true });
  const api = bindClient(Launcher, client);
  const pinEvents: boolean[] = [];
  const subscription = await client.subscribe(
    LauncherPinStateSchema.typeName,
    undefined,
    (bytes) => {
      pinEvents.push(fromBinary(LauncherPinStateSchema, bytes).pinned);
    },
  );
  try {
    await api.updateLayout(
      create(UpdateLayoutRequestSchema, { mode: LauncherMode.QUICK_CHAT, resultCount: 2 }),
    );
    await api.updateLayout(create(UpdateLayoutRequestSchema, { mode: LauncherMode.SEARCH }));
    assert.deepEqual(sizes, [
      [800, 580],
      [800, 71],
    ]);
    assert.deepEqual(modes, ["quick-chat", "search"]);
    await assert.rejects(
      api.updateLayout(create(UpdateLayoutRequestSchema, { mode: 999 as LauncherMode })),
      /handler or transport failed/,
    );
    assert.equal(sizes.length, 2);
    assert.equal((await api.getPinState(create(EmptySchema))).pinned, false);
    assert.equal(
      (await api.setPinState(create(LauncherPinStateSchema, { pinned: true }))).pinned,
      true,
    );
    assert.equal((await api.getPinState(create(EmptySchema))).pinned, true);
    await new Promise(setImmediate);
    assert.deepEqual(pinEvents, [true]);
    assert.equal((await api.setPinState(create(LauncherPinStateSchema))).pinned, false);
    await new Promise(setImmediate);
    assert.deepEqual(pinEvents, [true, false]);
  } finally {
    subscription.close();
    owner.close();
  }
});
