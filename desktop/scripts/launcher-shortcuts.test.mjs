import assert from "node:assert/strict";
import { test } from "node:test";
import { activateLauncherShortcut } from "../src/main/launcher-shortcuts.ts";

function fixture({ visible = true, focused = true, destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    show: () => calls.push(["show"]),
    window: {
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      isFocused: () => focused,
      hide: () => calls.push(["hide"]),
      setSize: (...size) => calls.push(["size", ...size]),
      webContents: { send: (...args) => calls.push(["send", ...args]) },
    },
  };
}

test("same-mode shortcuts hide only when the launcher is visible and focused", () => {
  for (const mode of ["search", "clipboard"]) {
    const { window, show, calls } = fixture();
    assert.equal(activateLauncherShortcut(window, mode, mode, show), mode);
    assert.deepEqual(calls, [["hide"]]);
    for (const state of [{ visible: false }, { focused: false }]) {
      const next = fixture(state);
      activateLauncherShortcut(next.window, mode, mode, next.show);
      assert.deepEqual(next.calls, [["send", "launcher:open", mode], ["show"]]);
    }
  }
});

test("cross-mode shortcuts resize and switch before showing instead of hiding", () => {
  for (const [from, to, height] of [
    ["search", "clipboard", 580],
    ["clipboard", "search", 71],
  ]) {
    const { window, show, calls } = fixture();
    assert.equal(activateLauncherShortcut(window, from, to, show), to);
    assert.deepEqual(calls, [["size", 800, height], ["send", "launcher:open", to], ["show"]]);
  }
});

test("missing or destroyed windows are ignored", () => {
  const { window, show, calls } = fixture({ destroyed: true });
  assert.equal(activateLauncherShortcut(undefined, "search", "clipboard", show), "search");
  assert.equal(activateLauncherShortcut(window, "search", "clipboard", show), "search");
  assert.deepEqual(calls, []);
});
