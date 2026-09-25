import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { BrowserWindow } from "electron";
import { Launcher, LauncherMode, UpdateLayoutRequestSchema } from "xiaowei-contracts";
import { bindClient } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { registerSearch } from "../../src/main/services/launcher/gateway";

test("Launcher host uses a fixed chat height and restores search height", async () => {
  const sizes: number[][] = [];
  const modes: string[] = [];
  const window = { setSize: (...size: number[]) => sizes.push(size) } as unknown as BrowserWindow;
  const host = new GatewayHost();
  const owner = registerSearch(host, () => window, {
    development: false,
    platform: process.platform,
    async openExternal() {},
    writeText() {},
    async restart() {},
    resetPosition() {},
    iconUrl: () => "",
    includeChromeBookmarks: async () => false,
    modeChanged: (mode) => {
      modes.push(mode);
    },
  });
  const api = bindClient(Launcher, host.client({ caller: "test", trusted: true }));
  try {
    await api.updateLayout(create(UpdateLayoutRequestSchema, { mode: LauncherMode.QUICK_CHAT, resultCount: 2 }));
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
  } finally {
    owner.close();
  }
});
