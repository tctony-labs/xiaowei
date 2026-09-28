import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mock, test } from "node:test";

const require = createRequire(new URL("../../package.json", import.meta.url));
let window: FakeWindow;
class FakeWindow extends EventEmitter {
  visible = false;
  focused = false;
  shows = 0;
  webContents = {
    on() {},
    setWindowOpenHandler() {},
    isDevToolsOpened: () => false,
  };

  constructor() {
    super();
    window = this;
  }

  isDestroyed() {
    return false;
  }
  isVisible() {
    return this.visible;
  }
  isFocused() {
    return this.focused;
  }
  getSize() {
    return [800, 71];
  }
  getBounds() {
    return { x: 0, y: 0, width: 800, height: 71 };
  }
  setVisibleOnAllWorkspaces() {}
  setPosition() {}
  setSize() {}
  show() {
    this.shows++;
    this.visible = true;
  }
  focus() {
    this.focused = true;
  }
  hide() {
    this.visible = false;
    this.focused = false;
    this.emit("blur");
  }
  async loadFile() {
    this.emit("ready-to-show");
  }
}

const display = { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } };
mock.module(require.resolve("electron"), {
  exports: {
    app: { isPackaged: true },
    BrowserWindow: FakeWindow,
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display,
    },
  },
});
const { createLauncherWindow } = await import("../../src/main/windows/launcher.ts");

test("Launcher starts hidden on macOS; repeated Tray calls preserve presentation and focus source", async () => {
  let captures = 0;
  let restores = 0;
  let abandoned = 0;
  let opened = 0;
  const launcher = createLauncherWindow({
    moduleDir: "/unused",
    register() {},
    opened() {
      opened++;
    },
    focus: {
      async begin() {
        captures++;
        return true;
      },
      async restore() {
        restores++;
        return true;
      },
      abandon() {
        abandoned++;
      },
    },
  });
  await launcher.create();
  if (process.platform === "darwin") assert.equal(window.visible, false);
  launcher.show();
  await new Promise(setImmediate);
  const before = window.shows;
  launcher.show();
  assert.equal(window.shows, before);
  assert.equal(captures, 1);
  assert.equal(opened, 0);
  launcher.openMode("clipboard");
  assert.equal(captures, 1);
  assert.equal(opened, 1);
  launcher.openMode("clipboard");
  await new Promise(setImmediate);
  assert.equal(window.visible, false);
  assert.equal(restores, 1);
  assert.equal(abandoned, 0);
  launcher.show();
  await new Promise(setImmediate);
  window.focused = false;
  window.emit("blur");
  assert.equal(abandoned, 1);
  assert.equal(restores, 1);
  launcher.prepareQuit();
});
