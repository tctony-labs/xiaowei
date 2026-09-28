import assert from "node:assert/strict";
import { test } from "node:test";
import { createShortcutRegistry } from "../src/main/services/shortcuts/registry.ts";

function fixture() {
  const native = new Map();
  const registry = createShortcutRegistry({
    register(key, action) {
      if (native.has(key)) return false;
      native.set(key, action);
      return true;
    },
    unregister: (key) => native.delete(key),
  });
  return { native, registry };
}

test("menu handoff covers arbitrary registered actions and restores them once", () => {
  const { native, registry } = fixture();
  const invoked = [];
  for (const key of ["Command+Space", "Command+Shift+X", "Control+Alt+F9"]) {
    assert.ok(registry.register(key, () => invoked.push(key)));
  }
  const handoff = registry.suspendForMenu();
  assert.equal(native.size, 0);
  assert.equal(handoff.entries.length, 3);
  assert.throws(() => registry.suspendForMenu(), /already active/);
  handoff.entries[2].invoke();
  assert.deepEqual(invoked, ["Control+Alt+F9"]);
  handoff.restore();
  handoff.restore();
  assert.equal(native.size, 3);
  native.get("Command+Space")();
  assert.deepEqual(invoked, ["Control+Alt+F9", "Command+Space"]);
});

test("menu restoration uses current registrations and ignores removed actions", () => {
  const { native, registry } = fixture();
  let invoked = 0;
  registry.register("Command+Space", () => invoked++);
  const handoff = registry.suspendForMenu();
  registry.unregister("Command+Space");
  registry.register("Command+K", () => invoked++);
  handoff.entries[0].invoke();
  assert.equal(invoked, 0);
  assert.equal(native.size, 0);
  handoff.restore();
  assert.deepEqual([...native.keys()], ["Command+K"]);

  const closing = registry.suspendForMenu();
  registry.close();
  closing.restore();
  assert.equal(native.size, 0);
});
