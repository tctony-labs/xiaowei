import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createOrdinaryWindows } from "../src/main/windows/ordinary-windows.ts";

class Window extends EventEmitter {
  minimized = false;
  destroyed = false;
  focuses = 0;

  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.minimized = false;
  }
  show() {
    this.emit("show");
  }
  focus() {
    this.focuses++;
    this.emit("focus");
  }
}

test("only registered and shown windows cycle; minimized windows remain candidates", () => {
  const manager = createOrdinaryWindows();
  const windows = Array.from({ length: 3 }, () => new Window());
  const loading = new Window();
  manager.register(loading);
  for (const window of windows) {
    manager.register(window);
    window.show();
  }
  windows[1].minimized = true;
  for (let i = 0; i < 4; i++) manager.activate();
  assert.deepEqual(
    windows.map((window) => window.focuses),
    [2, 1, 1],
  );
  assert.equal(loading.focuses, 0);
  assert.equal(windows[1].minimized, false);
  windows[0].emit("blur");
  manager.activate();
  assert.equal(windows[0].focuses, 3);
  windows[0].destroyed = true;
  windows[0].emit("closed");
  manager.activate();
  assert.equal(windows[1].focuses, 2);
  manager.close();
  manager.activate();
  assert.equal(windows[1].focuses, 2);
});

test("closing the last window while Dock show is pending eventually hides the Dock", async () => {
  let visible = false;
  let finish;
  const manager = createOrdinaryWindows({
    isVisible: () => visible,
    show: () =>
      new Promise((resolve) => {
        finish = () => {
          visible = true;
          resolve();
        };
      }),
    hide: () => {
      visible = false;
    },
  });
  const window = new Window();
  manager.register(window);
  window.show();
  window.emit("closed");
  finish();
  await new Promise(setImmediate);
  assert.equal(visible, false);
  manager.close();
});

function guardedDock() {
  let visible = false;
  let shownAt = 0;
  let hides = 0;
  return {
    isVisible: () => visible,
    hides: () => hides,
    async show() {
      shownAt = Date.now();
      visible = true;
    },
    hide() {
      hides++;
      // Electron ignores hide for one second after show on macOS.
      if (Date.now() - shownAt >= 1000) visible = false;
    },
  };
}

test("each completed Dock show reapplies the icon after the host restores its default", async () => {
  let visible = false;
  let icon = "Electron";
  let finish;
  let iconUpdates = 0;
  const manager = createOrdinaryWindows(
    {
      isVisible: () => visible,
      show: () =>
        new Promise((resolve) => {
          finish = () => {
            visible = true;
            icon = "Electron";
            resolve();
          };
        }),
      hide() {
        visible = false;
      },
    },
    () => {
      icon = "XiaoWei";
      iconUpdates++;
    },
  );

  manager.initialize();
  await new Promise(setImmediate);
  assert.equal(iconUpdates, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const window = new Window();
    manager.register(window);
    window.show();
    assert.equal(iconUpdates, attempt);
    finish();
    await new Promise(setImmediate);
    assert.equal(icon, "XiaoWei");
    assert.equal(iconUpdates, attempt + 1);
    window.emit("closed");
    await new Promise(setImmediate);
  }
  manager.close();
});

test("quickly closing settings retries a Dock hide ignored by Electron", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const dock = guardedDock();
  const manager = createOrdinaryWindows(dock);
  t.after(() => manager.close());
  const window = new Window();
  manager.register(window);
  window.show();
  await new Promise(setImmediate);
  window.emit("closed");
  await new Promise(setImmediate);
  assert.equal(dock.isVisible(), true);

  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.equal(dock.isVisible(), false);
});

test("reopening settings before the hide retry keeps the Dock visible", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const dock = guardedDock();
  const manager = createOrdinaryWindows(dock);
  t.after(() => manager.close());
  const first = new Window();
  manager.register(first);
  first.show();
  await new Promise(setImmediate);
  first.emit("closed");
  await new Promise(setImmediate);

  const second = new Window();
  manager.register(second);
  second.show();
  await new Promise(setImmediate);
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.equal(dock.isVisible(), true);
  assert.equal(dock.hides(), 1);

  second.emit("closed");
  await new Promise(setImmediate);
  assert.equal(dock.isVisible(), false);
});

test("quitting cancels a pending Dock hide retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const dock = guardedDock();
  const manager = createOrdinaryWindows(dock);
  const window = new Window();
  manager.register(window);
  window.show();
  await new Promise(setImmediate);
  window.emit("closed");
  await new Promise(setImmediate);

  manager.close();
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.equal(dock.hides(), 1);
});
