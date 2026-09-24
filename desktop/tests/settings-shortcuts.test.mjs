import assert from "node:assert/strict";
import { test } from "node:test";
import { accelerator, createSettingsShortcuts } from "../src/main/services/shortcuts/shortcuts.ts";

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
