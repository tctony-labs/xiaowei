import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { test } from "node:test";
import { startApplicationInspect } from "../src/main/services/inspect/host.ts";
import { callInspect } from "./inspect-test-client.mjs";

for (const kind of ["workspace", "app"]) {
  test(`${kind} method discovery and controls read the existing owner`, async (t) => {
    const path = await realpath(await mkdtemp("/tmp/xwi-host-"));
    t.after(() => rm(path, { recursive: true, force: true }));
    let visible = false;
    let mode = "search";
    let changes = 0;
    const windows = () => [{ role: "launcher", visible, mode }];
    const server = await startApplicationInspect({
      source: { kind, path },
      version: "fixture",
      appPath: path,
      dataPath: "/unchanged/shared-data",
      status: () => ({ changes }),
      windows,
      shortcuts: () => [{ action: "quickChat", state: "suspended", registered: false }],
      async showLauncher(requestedMode) {
        mode = requestedMode;
        visible = true;
        changes++;
      },
      async hideLauncher() {
        if (!visible) return null;
        visible = false;
        changes++;
        return false;
      },
    });
    t.after(() => server.close());
    const call = (method, params) => callInspect(server, method, params);
    const capabilities = await call("system.capabilities");
    assert.equal(capabilities.instance.source.path, path);
    assert.equal(capabilities.instance.dataPath, "/unchanged/shared-data");
    assert.equal(
      capabilities.methods.some(({ name }) => name === "settings.open"),
      false,
    );
    assert.equal(
      capabilities.methods.find(({ name }) => name === "launcher.show").params.mode.required,
      true,
    );
    for (const { name } of capabilities.methods.filter(({ mutates }) => !mutates)) {
      await call(name);
    }
    assert.equal(changes, 0);
    assert.equal(visible, false);
    const shown = await call("launcher.show", { mode: "quick-chat" });
    assert.equal(shown.windows[0].visible, true);
    assert.equal(shown.windows[0].mode, "quick-chat");
    assert.equal((await call("shortcut.list"))[0].state, "suspended");
    const hidden = await call("launcher.hide");
    assert.equal(hidden.focusRestored, false);
    assert.equal(hidden.windows[0].visible, false);
    assert.equal((await call("launcher.hide")).focusRestored, null);
    assert.equal((await call("system.identify")).instanceId, capabilities.instance.instanceId);
  });
}
