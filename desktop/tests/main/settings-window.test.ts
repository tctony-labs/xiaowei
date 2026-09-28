import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import type { Rectangle } from "electron";

const require = createRequire(new URL("../../package.json", import.meta.url));
const primary = { id: 1, workArea: { x: 0, y: 25, width: 1920, height: 1055 } };
const secondary = { id: 2, workArea: { x: -2560, y: -200, width: 2560, height: 1440 } };
let focused: { getBounds(): Rectangle } | null = null;
let cursorDisplay = primary;

class FakeWindow extends EventEmitter {
  bounds: Rectangle;
  shownBounds: Rectangle[] = [];
  webContents = {
    setWindowOpenHandler() {},
    on() {},
  };

  constructor(bounds: Rectangle) {
    super();
    this.bounds = { x: bounds.x ?? 0, y: bounds.y ?? 0, width: bounds.width, height: bounds.height };
  }

  static getFocusedWindow() {
    return focused;
  }

  getBounds() {
    return { ...this.bounds };
  }

  getSize() {
    return [this.bounds.width, this.bounds.height];
  }

  setPosition(x: number, y: number) {
    this.bounds = { ...this.bounds, x, y };
  }

  isDestroyed() {
    return false;
  }

  isMinimized() {
    return false;
  }

  show() {
    this.shownBounds.push(this.getBounds());
  }

  focus() {
    focused = this;
  }

  async loadFile() {
    this.emit("ready-to-show");
  }
}

mock.module(require.resolve("electron"), {
  exports: {
    app: { isPackaged: true, getVersion: () => "test", show() {} },
    BrowserWindow: FakeWindow,
    screen: {
      getDisplayMatching: (bounds: Rectangle) => (bounds.x < 0 ? secondary : primary),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => cursorDisplay,
    },
  },
});

const { createSettingsWindow } = await import("../../src/main/windows/settings.ts");

function controller() {
  return createSettingsWindow({
    moduleDir: "/unused/main",
    hideLauncher() {
      focused = null;
    },
    register() {},
  });
}

test("new settings follow the focused launcher before hiding it, even with the cursor on another display", async () => {
  focused = { getBounds: () => ({ x: -1800, y: 100, width: 800, height: 71 }) };
  cursorDisplay = primary;
  const window = (await controller().open()) as unknown as FakeWindow;
  assert.deepEqual(window.shownBounds, [{ x: -1680, y: 220, width: 800, height: 600 }]);
});

test("reused settings move across displays with their resized dimensions and preserve same-display dragging", async () => {
  focused = null;
  cursorDisplay = primary;
  const settings = controller();
  const window = (await settings.open()) as unknown as FakeWindow;
  window.bounds = { x: 100, y: 150, width: 1000, height: 700 };
  focused = { getBounds: () => ({ x: -1800, y: 100, width: 800, height: 71 }) };
  assert.equal(await settings.open(), window);
  assert.deepEqual(window.shownBounds.at(-1), { x: -1780, y: 170, width: 1000, height: 700 });

  window.setPosition(-2100, 80);
  await settings.open();
  assert.deepEqual(window.shownBounds.at(-1), { x: -2100, y: 80, width: 1000, height: 700 });
});

test("without a focused window, settings use the cursor display", async () => {
  focused = null;
  cursorDisplay = secondary;
  const window = await controller().open();
  assert.deepEqual(window.getBounds(), { x: -1680, y: 220, width: 800, height: 600 });
});
