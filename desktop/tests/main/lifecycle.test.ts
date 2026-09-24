import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EmptySchema, Settings, SettingsChangedSchema, SettingsSnapshotSchema } from "xiaowei-contracts";
import { bindEvent, bindHandlers } from "xiaowei-gateway";
import type { GatewayHost } from "xiaowei-gateway/host";

const require = createRequire(new URL("../../package.json", import.meta.url));
const calls: string[] = [];
let failure = "";
let directory = "";

mock.module(require.resolve("electron"), {
  exports: {
    BrowserWindow: { fromWebContents() {} },
    ipcMain: {},
    app: { getPath: () => directory },
    clipboard: {},
    shell: {},
    protocol: { handle: () => calls.push("protocol"), unhandle: () => {} },
  },
});
mock.module(require.resolve("xiaowei-storage"), {
  exports: {
    Storage: {
      async open() {
        calls.push("open-storage");
        if (failure === "storage" || failure === "migration") throw new Error(`${failure} failure`);
        return {
          createKeyValueGatewayEndpoint: () => ({}),
          createClipboardDaoGatewayEndpoint: () => ({}),
          createSettingsGatewayEndpoint: () => ({}),
        };
      },
    },
  },
});
mock.module(require.resolve("xiaowei-search"), {
  exports: { createSearchGatewayEndpoint: () => ({}) },
});
mock.module(require.resolve("xiaowei-clipboard"), {
  exports: {
    sendPasteShortcut: () => true,
    requestAccessibilityPermission: () => true,
    ClipboardHistory: {
      async open() {
        calls.push("open-clipboard");
        return {
          createGatewayEndpoint: () => ({}),
          async initialize() {
            calls.push("initialize");
          },
          async startServices() {
            calls.push("start");
            if (failure === "monitor") throw new Error("monitor failure");
          },
          async stopServices() {
            calls.push("stop");
          },
          async close() {},
          async stopMonitoring() {
            calls.push("stop");
          },
        };
      },
    },
  },
});
mock.module(import.meta.resolve("xiaowei-gateway/native"), {
  exports: {
    async attachNative(host: GatewayHost, name: string) {
      calls.push(`attach-${name}`);
      const owner =
        name === "settings"
          ? host.registerOwner(
              "settings-test",
              bindHandlers(Settings, {
                get: () =>
                  create(SettingsSnapshotSchema, {
                    clipboardEnabled: true,
                    clipboardRetentionDays: 30,
                    includeChromeBookmarks: true,
                  }),
                update: () => {
                  throw new Error("Unexpected settings update");
                },
              }),
              [bindEvent(SettingsChangedSchema, EmptySchema, "coalesce", () => true)],
            )
          : undefined;
      return {
        async close() {
          calls.push(`close-${name}`);
          owner?.close();
        },
      };
    },
  },
});
mock.module(import.meta.resolve("xiaowei-gateway/electron"), {
  exports: {
    attachElectron: () => ({
      close() {
        calls.push("close-electron");
      },
      register() {},
      target() {},
    }),
  },
});

mock.module(new URL("../../src/main/services/llm/host.ts", import.meta.url).href, {
  exports: {
    async attachLlm() {
      calls.push("attach-llm");
      if (failure === "llm") throw new Error("llm failure");
      return {
        async close() {
          calls.push("close-llm");
        },
      };
    },
  },
});

const { createApplicationGateway } = await import("../../src/main/app/gateway.ts");
const actions = {
  development: false,
  platform: "darwin",
  openExternal: async () => {},
  writeText() {},
  restart: async () => {},
  resetPosition() {},
  modeChanged() {},
  updateShortcuts() {},
};

test("desktop startup failures unwind producers and owners before Storage closes", async () => {
  directory = await mkdtemp(join(tmpdir(), "storage-lifecycle-"));
  try {
    const cases =
      process.platform === "darwin"
        ? ["llm", "storage", "migration", "monitor", ""]
        : ["llm", "storage", "migration", ""];
    for (const stage of cases) {
      failure = stage;
      calls.length = 0;
      if (stage) {
        await assert.rejects(
          createApplicationGateway(directory, "unused.sqlite", directory, actions),
          new RegExp(stage),
        );
      } else {
        const gateway = await createApplicationGateway(directory, "unused.sqlite", directory, actions);
        assert.ok(calls.indexOf("attach-storage") < calls.indexOf("attach-clipboard-dao"));
        assert.ok(calls.indexOf("attach-clipboard-dao") < calls.indexOf("initialize"));
        if (process.platform === "darwin") assert.ok(calls.indexOf("initialize") < calls.indexOf("start"));
        await gateway.close();
        await gateway.close();
        assert.equal(calls.filter((call) => call === "close-storage").length, 1);
      }
      if (stage !== "llm") assert.equal(calls.filter((call) => call === "close-llm").length, 1);
      if (stage === "llm") assert.ok(!calls.includes("open-storage"));
      if (stage !== "llm" && stage !== "storage" && stage !== "migration") {
        assert.ok(calls.indexOf("stop") < calls.indexOf("close-clipboard"));
        assert.ok(calls.indexOf("close-clipboard") < calls.indexOf("close-clipboard-dao"));
        assert.ok(calls.indexOf("close-clipboard-dao") < calls.indexOf("close-storage"));
      }
      assert.deepEqual(await readdir(directory), []);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
