import assert from "node:assert/strict";
import { test } from "node:test";
import { activateLauncherShortcut, positionLauncher, showLauncherWindow } from "../src/main/launcher-shortcuts.ts";

function fixture({ visible = true, focused = true, destroyed = false } = {}) {
  const calls = [];
  return {
    calls,
    show: () => calls.push(["show"]),
    opened: (_window, mode) => calls.push(["opened", mode]),
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
    const { window, show, calls, opened } = fixture();
    assert.equal(activateLauncherShortcut(window, mode, mode, show, opened), mode);
    assert.deepEqual(calls, [["hide"]]);
    for (const state of [{ visible: false }, { focused: false }]) {
      const next = fixture(state);
      activateLauncherShortcut(next.window, mode, mode, next.show, next.opened);
      assert.deepEqual(next.calls, [["opened", mode], ["show"]]);
    }
  }
});

test("cross-mode shortcuts resize and switch before showing instead of hiding", () => {
  for (const [from, to, height] of [
    ["search", "clipboard", 580],
    ["clipboard", "search", 71],
  ]) {
    const { window, show, calls, opened } = fixture();
    assert.equal(activateLauncherShortcut(window, from, to, show, opened), to);
    assert.deepEqual(calls, [["size", 800, height], ["opened", to], ["show"]]);
  }
});

test("missing or destroyed windows are ignored", () => {
  const { window, show, calls, opened } = fixture({ destroyed: true });
  assert.equal(activateLauncherShortcut(undefined, "search", "clipboard", show, opened), "search");
  assert.equal(activateLauncherShortcut(window, "search", "clipboard", show, opened), "search");
  assert.deepEqual(calls, []);
});

test("search, expanded results and clipboard share the same top-left on each display", () => {
  for (const workArea of [
    { x: 0, y: 25, width: 1440, height: 875 },
    { x: -1920, y: -1080, width: 1920, height: 1055 },
  ]) {
    const positions = [];
    for (const height of [71, 536, 580]) {
      positionLauncher(
        {
          getSize: () => [800, height],
          setPosition: (x, y) => positions.push([x, y]),
        },
        workArea,
      );
    }
    assert.deepEqual(positions[1], positions[0]);
    assert.deepEqual(positions[2], positions[0]);
    assert.equal(positions[0][0], workArea.x + (workArea.width - 800) / 2);
    assert.ok(positions[0][1] >= workArea.y);
  }
});

test("dragging then hiding and invoking a shortcut preserves position until explicit reset", () => {
  let position = [0, 0];
  let visible = false;
  let focused = false;
  const window = {
    isDestroyed: () => false,
    isVisible: () => visible,
    isFocused: () => focused,
    getSize: () => [800, 71],
    setPosition: (x, y) => {
      position = [x, y];
    },
    setSize: () => {},
    show: () => {
      visible = true;
    },
    focus: () => {
      focused = true;
    },
    hide: () => {
      visible = false;
      focused = false;
    },
    webContents: { send: () => {} },
  };
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const screen = {
    getCursorScreenPoint: () => ({ x: 200, y: 200 }),
    getDisplayNearestPoint: () => ({ id: 1, workArea }),
    getDisplayMatching: () => ({ id: 1 }),
  };
  window.getBounds = () => ({ x: position[0], y: position[1], width: 800, height: 71 });
  positionLauncher(window, workArea);
  const initial = [...position];
  showLauncherWindow(window, screen, "linux");
  window.setPosition(120, 300);
  window.hide();
  activateLauncherShortcut(
    window,
    "search",
    "search",
    () => showLauncherWindow(window, screen, "linux"),
    () => {},
  );
  assert.deepEqual(position, [120, 300]);
  assert.equal(visible, true);
  assert.equal(focused, true);
  activateLauncherShortcut(
    window,
    "search",
    "clipboard",
    () => showLauncherWindow(window, screen, "linux"),
    () => {},
  );
  assert.deepEqual(position, [120, 300]);
  positionLauncher(window, workArea);
  assert.deepEqual(position, initial);
});

test("invoking the launcher follows the cursor to another display before showing", () => {
  for (const [x, y, expected] of [
    [320, 156, [-1360, -922]],
    [120, 300, [-1627, -748]],
  ]) {
    for (const height of [71, 536, 580]) {
      const calls = [];
      const cursor = { x: -1000, y: -500 };
      const workArea = { x: -1920, y: -1080, width: 1920, height: 1055 };
      const bounds = { x, y, width: 800, height };
      const window = {
        isDestroyed: () => false,
        getBounds: () => bounds,
        getSize: () => [800, height],
        setPosition: (...position) => calls.push(["position", ...position]),
        show: () => calls.push(["show"]),
        focus: () => calls.push(["focus"]),
      };
      const screen = {
        getCursorScreenPoint: () => cursor,
        getDisplayNearestPoint: (point) => {
          assert.deepEqual(point, cursor);
          return { id: 2, workArea };
        },
        getDisplayMatching: (rectangle) => {
          assert.deepEqual(rectangle, bounds);
          return { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
        },
      };

      showLauncherWindow(window, screen, "linux");

      assert.deepEqual(calls, [["position", ...expected], ["show"], ["focus"]]);
    }
  }
});

test("macOS keeps all-Space visibility enabled while showing the launcher", () => {
  const calls = [];
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const window = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 320, y: 156, width: 800, height: 71 }),
    setVisibleOnAllWorkspaces: (visible) => calls.push(["all-workspaces", visible]),
    show: () => calls.push(["show"]),
    focus: () => calls.push(["focus"]),
  };
  const screen = {
    getCursorScreenPoint: () => ({ x: 200, y: 200 }),
    getDisplayNearestPoint: () => ({ id: 1, workArea }),
    getDisplayMatching: () => ({ id: 1, workArea }),
  };

  showLauncherWindow(window, screen, "darwin");

  assert.deepEqual(calls, [["all-workspaces", true], ["show"], ["focus"]]);
});
