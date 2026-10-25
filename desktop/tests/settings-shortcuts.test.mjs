import assert from "node:assert/strict";
import { test } from "node:test";
import { createShortcutRegistry } from "../src/main/services/shortcuts/registry.ts";
import {
  accelerator,
  createSettingsShortcuts,
  shortcutConfig,
} from "../src/main/services/shortcuts/shortcuts.ts";

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

test("inspection separates configured bindings from failed and suspended registrations", () => {
  const native = new Map();
  const blocked = new Set(["Command+Space"]);
  let changes = 0;
  const registry = createShortcutRegistry({
    isRegistered: (key) => native.has(key),
    register(key, action) {
      changes++;
      if (blocked.has(key)) return false;
      native.set(key, action);
      return true;
    },
    unregister(key) {
      changes++;
      native.delete(key);
    },
  });
  const shortcuts = createSettingsShortcuts(registry, "darwin", {
    main() {},
    clipboard() {},
  });
  shortcuts.registerInitial(initial);
  const before = changes;
  assert.deepEqual(
    shortcuts.snapshot().map(({ state }) => state),
    ["unavailable", "registered", "disabled"],
  );
  assert.equal(changes, before, "querying must not re-register shortcuts");
  const handoff = registry.suspendForMenu();
  assert.equal(shortcuts.snapshot()[1].state, "suspended");
  blocked.add("Command+Shift+X");
  handoff.restore();
  assert.equal(shortcuts.snapshot()[1].state, "unavailable");
  shortcuts.close();
  registry.close();
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
  assert.throws(
    () => shortcut.replace({ ...initial, quickChat: ["Meta", "Shift", "KeyC"] }),
    /action unavailable/,
  );
  shortcut.close();
  assert.equal(registered.size, 0);
});

test("quick chat uses saved bindings on startup, supports changes and stays cleared", () => {
  for (const [platform, modifier, key] of [
    ["darwin", "Meta", "Command+Shift+C"],
    ["linux", "Control", "Control+Shift+C"],
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
    const config = shortcutConfig({ quickChat: { keys: [modifier, "Shift", "KeyC"] } });
    shortcuts.registerInitial(config);
    registered.get(key)();
    const custom = shortcutConfig({ quickChat: { keys: [modifier, "Alt", "KeyQ"] } });
    shortcuts.replace(custom);
    assert.equal(registered.has(key), false);
    registered.get(accelerator(custom.quickChat, platform))();
    assert.equal(opened, 2);

    shortcuts.replace(shortcutConfig({}));
    assert.equal(registered.size, 0);
    shortcuts.registerInitial(shortcutConfig(undefined));
    assert.equal(registered.size, 0);
    shortcuts.close();
    assert.equal(registered.size, 0);
  }
});
