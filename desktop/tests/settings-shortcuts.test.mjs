import assert from "node:assert/strict";
import { test } from "node:test";
import { accelerator, createSettingsShortcuts, shortcutConfig } from "../src/main/services/shortcuts/shortcuts.ts";

const initial = {
  main: ["Meta", "Space"],
  clipboard: ["Meta", "Shift", "KeyX"],
  quickChat: null,
};

test("KeyboardEvent codes convert into platform accelerators", () => {
  assert.equal(accelerator(["Meta", "Alt", "Digit1"], "darwin"), "Command+Alt+1");
  assert.equal(accelerator(["Control", "Shift", "ArrowUp"], "linux"), "Control+Shift+Up");
  assert.equal(accelerator(["Meta", "Shift", "KeyX"], "win32"), "Super+Shift+X");
  assert.equal(accelerator(null, "darwin"), null);
});

test("failed registration restores the prior shortcuts", () => {
  const registered = new Map();
  const shortcut = createSettingsShortcuts(
    {
      register: (key, action) => {
        if (key === "Command+Alt+Q") return false;
        registered.set(key, action);
        return true;
      },
      unregister: (key) => registered.delete(key),
    },
    "darwin",
    { main: () => {}, clipboard: () => {} },
  );
  shortcut.replace(initial);
  const before = [...registered.keys()];
  assert.throws(
    () =>
      shortcut.replace({
        main: ["Meta", "Alt", "KeyQ"],
        clipboard: ["Meta", "Shift", "KeyX"],
        quickChat: null,
      }),
    /unavailable/,
  );
  assert.deepEqual([...registered.keys()], before);
  assert.throws(() => shortcut.replace({ ...initial, quickChat: ["Meta", "Shift", "KeyC"] }), /action unavailable/);
  shortcut.close();
  assert.equal(registered.size, 0);
});

test("quick chat registers its default binding on startup and after settings changes", () => {
  for (const [platform, key] of [
    ["darwin", "Command+Shift+C"],
    ["linux", "Control+Shift+C"],
  ]) {
    const registered = new Map();
    let opened = 0;
    const shortcuts = createSettingsShortcuts(
      {
        register: (binding, action) => {
          registered.set(binding, action);
          return true;
        },
        unregister: (binding) => registered.delete(binding),
      },
      platform,
      { quickChat: () => opened++ },
    );
    const config = shortcutConfig(undefined, platform);
    shortcuts.registerInitial(config);
    registered.get(key)();
    shortcuts.replace(config);
    registered.get(key)();
    assert.equal(opened, 2);
    shortcuts.close();
    assert.equal(registered.size, 0);
  }
});
