import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createOrdinaryWindows } from "../src/main/windows/ordinary-windows.ts";

class Window extends EventEmitter {
  minimized = false;
  destroyed = false;
  visible = false;
  focused = false;
  focuses = 0;

  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }

  isVisible() {
    return this.visible;
  }

  isFocused() {
    return this.focused;
  }

  restore() {
    this.minimized = false;
  }
  show() {
    this.visible = true;
    this.emit("show");
  }
  focus() {
    this.focused = true;
    this.focuses++;
    this.emit("focus");
  }
}

test("Dock snapshots show deferred visibility without applying it", async () => {
  let visible = true;
  const changes = [];
  const manager = createOrdinaryWindows({
    isVisible: () => visible,
    async show() {
      changes.push("show");
      visible = true;
    },
    hide() {
      changes.push("hide");
      visible = false;
    },
  });
  manager.setNativeWindowVisible(true);
  manager.setTransientWindowVisible(true);
  manager.setNativeWindowVisible(false);
  await new Promise(setImmediate);
  const snapshot = manager.snapshot();
  assert.equal(snapshot.visible, true);
  assert.equal(snapshot.desiredVisible, false);
  assert.equal(snapshot.hideDeferred, true);
  assert.deepEqual(changes, []);
  manager.setTransientWindowVisible(false);
  await new Promise(setImmediate);
  assert.equal(manager.snapshot().visible, false);
  assert.deepEqual(changes, ["hide"]);
  manager.close();
});

test("registering an already visible and focused window includes it immediately", async () => {
  let visible = false;
  const manager = createOrdinaryWindows({
    isVisible: () => visible,
    async show() {
      visible = true;
    },
    hide() {
      visible = false;
    },
  });
  const window = new Window();
  window.show();
  window.focus();
  manager.register(window);
  await new Promise(setImmediate);
  assert.equal(visible, true);
  assert.equal(manager.focused(), window);
  manager.activate();
  assert.equal(window.focuses, 2);
  manager.close();
});

test("unregistering a reusable window removes its activation state and listeners", () => {
  const manager = createOrdinaryWindows();
  const settings = new Window();
  const chat = new Window();
  manager.register(settings);
  settings.show();
  for (let attempt = 0; attempt < 3; attempt++) {
    chat.show();
    chat.focus();
    manager.register(chat);
    assert.equal(manager.focused(), chat);
    manager.unregister(chat);
    assert.equal(manager.focused(), undefined);
    assert.equal(chat.eventNames().length, 0);
    manager.activate();
    assert.equal(manager.focused(), settings);
  }
  assert.equal(chat.focuses, 3);
  manager.close();
});

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

test("native windows share Dock visibility with ordinary windows", async () => {
  let visible = false;
  const manager = createOrdinaryWindows({
    isVisible: () => visible,
    async show() {
      visible = true;
    },
    hide() {
      visible = false;
    },
  });

  manager.initialize();
  manager.setNativeWindowVisible(true);
  await new Promise(setImmediate);
  assert.equal(visible, true);

  const settings = new Window();
  manager.register(settings);
  settings.show();
  manager.setNativeWindowVisible(false);
  await new Promise(setImmediate);
  assert.equal(visible, true);

  manager.setNativeWindowVisible(true);
  settings.emit("closed");
  await new Promise(setImmediate);
  assert.equal(visible, true);
  manager.setNativeWindowVisible(false);
  await new Promise(setImmediate);
  assert.equal(visible, false);

  manager.close();
  manager.setNativeWindowVisible(true);
  await new Promise(setImmediate);
  assert.equal(visible, false);
});

test("native UI dismissal while Dock show is pending eventually hides the Dock", async () => {
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
    hide() {
      visible = false;
    },
  });
  manager.setNativeWindowVisible(true);
  manager.setNativeWindowVisible(false);
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

test("a transient popup defers hiding an existing Dock icon without showing one", async () => {
  let visible = false;
  let shows = 0;
  let hides = 0;
  const manager = createOrdinaryWindows({
    isVisible: () => visible,
    async show() {
      shows++;
      visible = true;
    },
    hide() {
      hides++;
      visible = false;
    },
  });

  manager.setTransientWindowVisible(true);
  await new Promise(setImmediate);
  assert.equal(shows, 0);
  assert.equal(visible, false);

  const chat = new Window();
  chat.show();
  manager.register(chat);
  await new Promise(setImmediate);
  manager.unregister(chat);
  await new Promise(setImmediate);
  assert.equal(visible, true);
  assert.equal(hides, 0);
  manager.activate();
  assert.equal(chat.focuses, 0);

  manager.setTransientWindowVisible(false);
  await new Promise(setImmediate);
  assert.equal(visible, false);
  assert.equal(hides, 1);
  manager.close();
});

test("a visible transient popup cancels the one-second Dock hide retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const dock = guardedDock();
  const manager = createOrdinaryWindows(dock);
  t.after(() => manager.close());
  const settings = new Window();
  manager.register(settings);
  settings.show();
  await new Promise(setImmediate);
  settings.emit("closed");
  await new Promise(setImmediate);
  assert.equal(dock.hides(), 1);

  manager.setTransientWindowVisible(true);
  await new Promise(setImmediate);
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.equal(dock.isVisible(), true);
  assert.equal(dock.hides(), 1);

  manager.setTransientWindowVisible(false);
  await new Promise(setImmediate);
  assert.equal(dock.isVisible(), false);
  assert.equal(dock.hides(), 2);
});

test("dismissing a transient popup preserves Dock for settings and native windows", async () => {
  let visible = false;
  const manager = createOrdinaryWindows({
    isVisible: () => visible,
    async show() {
      visible = true;
    },
    hide() {
      visible = false;
    },
  });
  const settings = new Window();
  manager.register(settings);
  settings.show();
  manager.setTransientWindowVisible(true);
  await new Promise(setImmediate);

  manager.setTransientWindowVisible(false);
  await new Promise(setImmediate);
  assert.equal(visible, true);
  manager.setTransientWindowVisible(true);
  manager.setNativeWindowVisible(true);
  settings.emit("closed");
  manager.setTransientWindowVisible(false);
  await new Promise(setImmediate);
  assert.equal(visible, true);

  manager.setNativeWindowVisible(false);
  await new Promise(setImmediate);
  assert.equal(visible, false);
  manager.close();
});
