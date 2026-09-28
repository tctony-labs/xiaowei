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
