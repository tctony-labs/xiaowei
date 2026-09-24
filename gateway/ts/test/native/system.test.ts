import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { EmptySchema, OpenUrlRequestSchema, System, Theme, ToggleThemeResponseSchema } from "xiaowei-contracts";
import { bindClient, bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";

const require = createRequire(new URL("../../../../desktop/package.json", import.meta.url));
const opened: string[] = [];
let fail = false;

mock.module(require.resolve("electron"), {
  exports: {
    shell: {
      async openExternal(url: string) {
        if (fail) throw new Error("Unable to open browser");
        opened.push(url);
      },
    },
  },
});

const { registerSystem } = await import("../../../../desktop/src/main/services/system/gateway.ts");

test("System opens only web URLs without clipboard and coexists with native theme owner", async () => {
  const host = new GatewayHost();
  const theme = host.registerOwner(
    "native-theme",
    bindHandlers(
      System,
      { toggleTheme: () => create(ToggleThemeResponseSchema, { theme: Theme.DARK }) },
      { partial: true },
    ),
  );
  const owner = registerSystem(host);
  const api = bindClient(System, host.client({ caller: "window", trusted: true }));
  try {
    await api.openUrl(create(OpenUrlRequestSchema, { url: "https://example.com" }));
    await api.openUrl(create(OpenUrlRequestSchema, { url: "http://example.com/path" }));
    assert.deepEqual(opened, ["https://example.com/", "http://example.com/path"]);
    assert.equal((await api.toggleTheme(create(EmptySchema))).theme, Theme.DARK);

    for (const url of [
      "",
      "not a URL",
      "file:///tmp/a",
      "javascript:alert(1)",
      "data:text/html,hi",
      "app://run",
      "x-apple.systempreferences:com.apple.preference.general",
      `https://example.com/${"x".repeat(16384)}`,
    ]) {
      await assert.rejects(api.openUrl(create(OpenUrlRequestSchema, { url })));
    }
    assert.equal(opened.length, 2);

    fail = true;
    await assert.rejects(api.openUrl(create(OpenUrlRequestSchema, { url: "https://example.com" })));
    owner.close();
    await assert.rejects(api.openUrl(create(OpenUrlRequestSchema, { url: "https://example.com" })));
    assert.equal((await api.toggleTheme(create(EmptySchema))).theme, Theme.DARK);
  } finally {
    owner.close();
    theme.close();
  }
});
