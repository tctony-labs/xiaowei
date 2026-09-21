import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const require = createRequire(new URL("../../../../desktop/package.json", import.meta.url));
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
        if (failure === "storage") throw new Error("storage failure");
        return { createGatewayEndpoint: () => ({}) };
      },
    },
  },
});
mock.module(require.resolve("xiaowei-search"), {
  exports: { createSearchGatewayEndpoint: () => ({}) },
});
mock.module(require.resolve("xiaowei-clipboard"), {
  exports: {
    ClipboardHistory: {
      async open() {
        calls.push("open-clipboard");
        return {
          createGatewayEndpoint: () => ({}),
          async initialize() {
            calls.push("initialize");
            if (failure === "migration") throw new Error("migration failure");
          },
          async startMonitoring() {
            calls.push("start");
            if (failure === "monitor") throw new Error("monitor failure");
          },
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
    async attachNative(_host: unknown, name: string) {
      calls.push(`attach-${name}`);
      return {
        async close() {
          calls.push(`close-${name}`);
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

const { createApplicationGateway } = await import("../../../../desktop/src/main/gateway.ts");
const actions = {
  development: false,
  platform: "darwin",
  openPath: async () => "",
  openExternal: async () => {},
  writeText() {},
  restart: async () => {},
  resetPosition() {},
  modeChanged() {},
};

test("desktop startup failures unwind producers and owners before Storage closes", async () => {
  directory = await mkdtemp(join(tmpdir(), "storage-lifecycle-"));
  try {
    const cases =
      process.platform === "darwin" ? ["storage", "migration", "monitor", ""] : ["storage", "migration", ""];
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
        assert.ok(calls.indexOf("attach-storage") < calls.indexOf("initialize"));
        if (process.platform === "darwin") assert.ok(calls.indexOf("initialize") < calls.indexOf("start"));
        await gateway.close();
        await gateway.close();
        assert.equal(calls.filter((call) => call === "close-storage").length, 1);
      }
      if (stage !== "storage") {
        assert.ok(calls.indexOf("stop") < calls.indexOf("close-clipboard"));
        assert.ok(calls.indexOf("close-clipboard") < calls.indexOf("close-storage"));
      }
      assert.deepEqual(await readdir(directory), []);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
