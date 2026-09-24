import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { mock, test } from "node:test";
import { create } from "@bufbuild/protobuf";
import {
  ClipboardBiz,
  ClipboardItemRequestSchema,
  EmptySchema,
  Settings,
  SettingsChangedSchema,
  SettingsSnapshotSchema,
} from "xiaowei-contracts";
import { bindClient, bindEvent, bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";

const require = createRequire(new URL("../../../../desktop/package.json", import.meta.url));
const calls: string[] = [];
let autoPaste = true;

mock.module(require.resolve("electron"), {
  exports: {
    app: { getPath: () => tmpdir(), hide: () => calls.push("resign") },
    clipboard: {},
    shell: {},
  },
});
mock.module(require.resolve("xiaowei-clipboard"), {
  exports: {
    sendPasteShortcut: () => {
      calls.push("paste");
      return true;
    },
    ClipboardHistory: {
      async open() {
        return {
          createGatewayEndpoint: () => ({}),
          async initialize() {},
          async close() {},
          async stopMonitoring() {},
        };
      },
    },
  },
});
mock.module(import.meta.resolve("xiaowei-gateway/native"), {
  exports: {
    async attachNative(host: GatewayHost) {
      const owner = host.registerOwner(
        "copy-selection-test",
        bindHandlers(
          ClipboardBiz,
          {
            copy: async () => {
              calls.push("copy");
              return create(EmptySchema);
            },
          },
          { partial: true },
        ),
      );
      return { close: async () => owner.close() };
    },
  },
});

const { registerClipboard } = await import("../../../../desktop/src/main/services/clipboard/gateway.ts");

test("selection copies, resigns focus and pastes only when enabled; ordinary copy stays separate", async () => {
  const host = new GatewayHost();
  const settings = host.registerOwner(
    "settings-selection-test",
    bindHandlers(Settings, {
      get: () =>
        create(SettingsSnapshotSchema, {
          clipboardEnabled: false,
          clipboardAutoPaste: autoPaste,
          clipboardRetentionDays: -1,
        }),
      update: () => {
        throw new Error("Unexpected settings update");
      },
    }),
    [bindEvent(SettingsChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const clipboard = await registerClipboard(host, tmpdir(), "unused.sqlite", () => ({
    hide: () => calls.push("hide"),
  }));
  const api = bindClient(ClipboardBiz, host.client({ caller: "test", trusted: true }));
  try {
    if (process.platform !== "darwin") return;
    const item = create(ClipboardItemRequestSchema, { id: 1n });
    calls.length = 0;
    await api.select(item);
    assert.deepEqual(calls, ["copy", "hide", "resign", "paste"]);

    autoPaste = false;
    calls.length = 0;
    await api.select(item);
    assert.deepEqual(calls, ["copy", "hide", "resign"]);

    calls.length = 0;
    await api.copy(item);
    assert.deepEqual(calls, ["copy"]);

    calls.length = 0;
    await assert.rejects(api.select(create(ClipboardItemRequestSchema, { id: 0n })));
    assert.deepEqual(calls, []);
  } finally {
    await clipboard.close();
    settings.close();
  }
});
