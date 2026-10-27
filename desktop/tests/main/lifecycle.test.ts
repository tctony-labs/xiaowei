import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import {
  KeyValue,
  KvValueSchema,
  Settings,
  SettingsChangedSchema,
  SettingsSnapshotSchema,
} from "proto-desktop-ts";
import { bindEvent, bindHandlers } from "xiaowei-gateway";
import type { GatewayHost } from "xiaowei-gateway/host";

const require = createRequire(new URL("../../package.json", import.meta.url));
const calls: string[] = [];
let failure = "";
let directory = "";
let agentDirectory = "";

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
mock.module(require.resolve("xiaowei-agent"), {
  exports: {
    Agent: {
      async open(path: string) {
        assert.equal(path, agentDirectory);
        calls.push("create-agent");
        if (failure === "agent-create") throw new Error("agent-create failure");
        return {
          createGatewayEndpoint: () => ({}),
          async close() {
            calls.push("stop-agent");
          },
        };
      },
    },
  },
});
mock.module(require.resolve("xiaowei-rust"), {
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
    createSearchGatewayEndpoint: () => ({}),
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

mock.module(import.meta.resolve("xiaowei-gateway/rust-napi"), {
  exports: {
    async attachRustNapi(host: GatewayHost, name: string) {
      calls.push(`attach-${name}`);
      if (failure === "agent-attach" && name === "agent") throw new Error("agent-attach failure");
      const owner =
        name === "storage"
          ? host.registerOwner(
              "storage-test",
              bindHandlers(
                KeyValue,
                {
                  get: () => create(KvValueSchema),
                  set: () => create(EmptySchema),
                },
                { partial: true },
              ),
            )
          : name === "settings"
            ? host.registerOwner(
                "settings-test",
                bindHandlers(
                  Settings,
                  {
                    get: () =>
                      create(SettingsSnapshotSchema, {
                        clipboardEnabled: true,
                        clipboardRetentionDays: 30,
                        includeChromeBookmarks: true,
                      }),
                    update: () => {
                      throw new Error("Unexpected settings update");
                    },
                  },
                  { partial: true },
                ),
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
        async updateModels() {
          calls.push("update-llm");
        },
        async close() {
          calls.push("close-llm");
        },
      };
    },
  },
});

mock.module(new URL("../../src/main/services/account/session.ts", import.meta.url).href, {
  exports: {
    async registerAccountSession() {
      calls.push("register-account-session");
      return {
        start() {},
        async withServerContext() {
          throw new Error("Unexpected server request");
        },
        async execute() {
          throw new Error("Unexpected account operation");
        },
        nextMaintenanceAt: () => Date.now() + 30_000,
        async close() {
          calls.push("close-account-session");
        },
      };
    },
  },
});

const { createApplicationGateway } = await import("../../src/main/app/gateway.ts");
const actions = {
  async dismiss() {},
  windowGeneration: () => 0,
  async hideWindow() {},
  development: false,
  platform: "darwin",
  openExternal: async () => {},
  writeText() {},
  restart: async () => {},
  resetPosition() {},
  modeChanged() {},
  updateShortcuts() {},
  async openSettings() {
    throw new Error("Unused settings window");
  },
};

test("desktop startup failures unwind producers and owners before Storage closes", async () => {
  directory = await mkdtemp(join(tmpdir(), "storage-lifecycle-"));
  agentDirectory = join(directory, "independent-agent-root");
  try {
    const cases =
      process.platform === "darwin"
        ? ["llm", "agent-create", "agent-attach", "storage", "migration", "monitor", ""]
        : ["llm", "agent-create", "agent-attach", "storage", "migration", ""];
    for (const stage of cases) {
      failure = stage;
      calls.length = 0;
      if (stage) {
        await assert.rejects(
          createApplicationGateway(
            directory,
            "unused.sqlite",
            directory,
            agentDirectory,
            join(directory, "auth.json"),
            actions,
          ),
          new RegExp(stage),
        );
      } else {
        const gateway = await createApplicationGateway(
          directory,
          "unused.sqlite",
          directory,
          agentDirectory,
          join(directory, "auth.json"),
          actions,
        );
        assert.ok(calls.indexOf("attach-settings") < calls.indexOf("create-agent"));
        assert.ok(calls.indexOf("create-agent") < calls.indexOf("attach-agent"));
        assert.ok(calls.indexOf("attach-storage") < calls.indexOf("register-account-session"));
        assert.ok(
          calls.indexOf("register-account-session") < calls.indexOf("attach-clipboard-dao"),
        );
        assert.ok(calls.indexOf("attach-clipboard-dao") < calls.indexOf("initialize"));
        if (process.platform === "darwin")
          assert.ok(calls.indexOf("initialize") < calls.indexOf("start"));
        await gateway.updateLlmModels([]);
        assert.ok(calls.includes("update-llm"));
        assert.equal(gateway.close(), gateway.close());
        await gateway.close();
        assert.equal(calls.filter((call) => call === "close-storage").length, 1);
      }
      if (stage !== "llm") assert.equal(calls.filter((call) => call === "close-llm").length, 1);
      if (stage === "llm") assert.ok(!calls.includes("open-storage"));
      if (!["llm", "storage", "migration"].includes(stage)) {
        assert.equal(calls.filter((call) => call === "close-account-session").length, 1);
        assert.ok(calls.indexOf("close-account-session") < calls.indexOf("close-storage"));
      }
      if (!["llm", "agent-create", "agent-attach", "storage", "migration"].includes(stage)) {
        assert.ok(calls.indexOf("stop") < calls.indexOf("close-clipboard"));
        assert.ok(calls.indexOf("close-clipboard") < calls.indexOf("close-clipboard-dao"));
        assert.ok(calls.indexOf("close-clipboard-dao") < calls.indexOf("close-storage"));
      }
      if (!["llm", "agent-create", "storage", "migration"].includes(stage)) {
        assert.ok(calls.indexOf("stop-agent") < calls.indexOf("close-llm"));
        assert.ok(calls.indexOf("stop-agent") < calls.indexOf("close-settings"));
        if (stage !== "agent-attach") {
          assert.ok(calls.indexOf("stop-agent") < calls.indexOf("close-agent"));
          assert.ok(calls.indexOf("close-agent") < calls.indexOf("close-llm"));
        }
      }
      assert.deepEqual(await readdir(directory), []);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
