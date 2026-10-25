import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mock, type TestContext, test } from "node:test";
import type { BrowserWindow } from "electron";
import { createOrdinaryWindows } from "../../src/main/windows/ordinary-windows";

const require = createRequire(new URL("../../package.json", import.meta.url));
let window: FakeWindow;
let applicationActive = false;

class FakeWindow extends EventEmitter {
  alwaysOnTop: boolean;
  visible = false;
  focused = false;
  destroyed = false;
  shows = 0;
  webContents = {
    on() {},
    setWindowOpenHandler() {},
    isDevToolsOpened: () => false,
  };

  constructor(options: { alwaysOnTop?: boolean } = {}) {
    super();
    this.alwaysOnTop = options.alwaysOnTop ?? false;
    window = this;
  }

  setAlwaysOnTop(alwaysOnTop: boolean) {
    this.alwaysOnTop = alwaysOnTop;
  }

  isDestroyed() {
    return this.destroyed;
  }

  isMinimized() {
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

  restore() {}

  show() {
    this.shows++;
    this.visible = true;
    this.emit("show");
  }
  showInactive() {
    this.show();
  }
  focus() {
    applicationActive = true;
    this.focused = true;
    this.emit("focus");
  }
  hide() {
    const wasVisible = this.visible;
    const wasFocused = this.focused;
    this.visible = false;
    this.focused = false;
    if (wasVisible) this.emit("hide");
    if (wasFocused) this.emit("blur");
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

function trackedLauncher(t: TestContext) {
  const dock = {
    visible: false,
    isVisible() {
      return this.visible;
    },
    async show() {
      this.visible = true;
    },
    hide() {
      this.visible = false;
    },
  };
  const ordinaryWindows = createOrdinaryWindows(dock);
  const launcher = createLauncherWindow({
    moduleDir: "/unused",
    ordinaryWindows,
    register() {},
    opened() {},
  });
  t.after(() => {
    launcher.prepareQuit();
    ordinaryWindows.close();
  });
  return { launcher, ordinaryWindows, dock };
}

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
      snapshot: () => ({
        active: true,
        sourceProcessId: null,
        frontmostProcessId: null,
        generation: 0,
      }),
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

for (const selection of ["before-create", "before-ready", "shortcut", "renderer"]) {
  test(`Quick Chat (${selection}) survives blur and preserves its focus source`, async () => {
    let restores = 0;
    let abandoned = 0;
    const launcher = createLauncherWindow({
      moduleDir: "/unused",
      register() {
        if (selection === "before-ready") launcher.openMode("quick-chat");
      },
      opened() {},
      focus: {
        snapshot: () => ({
          active: true,
          sourceProcessId: null,
          frontmostProcessId: null,
          generation: 0,
        }),
        async begin() {
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
    if (selection === "before-create") launcher.openMode("quick-chat");
    await launcher.create();
    if (selection === "shortcut") launcher.openMode("quick-chat");
    if (selection === "renderer") {
      launcher.modeChanged("quick-chat");
      launcher.show();
    }
    await new Promise(setImmediate);
    assert.equal(window.alwaysOnTop, false);
    window.focused = false;
    window.emit("blur");
    assert.equal(window.visible, true);
    assert.equal(abandoned, 0);
    assert.equal(restores, 0);
    await launcher.dismiss(true);
    assert.equal(window.visible, false);
    assert.equal(restores, 1);
    launcher.prepareQuit();
  });
}

test("search and clipboard still hide on blur, including after leaving Quick Chat", async () => {
  const launcher = createLauncherWindow({
    moduleDir: "/unused",
    register() {},
    opened() {},
  });
  await launcher.create();
  for (const mode of ["search", "clipboard"] as const) {
    launcher.openMode("quick-chat");
    launcher.modeChanged(mode);
    await new Promise(setImmediate);
    assert.equal(window.visible, true);
    window.focused = false;
    window.emit("blur");
    assert.equal(window.visible, false);
  }
  launcher.prepareQuit();
});

test("mode changes restore the window level through shortcuts and renderer requests", async () => {
  const launcher = createLauncherWindow({
    moduleDir: "/unused",
    register() {},
    opened() {},
  });
  await launcher.create();
  assert.equal(window.alwaysOnTop, true);

  for (const change of [launcher.openMode, launcher.modeChanged]) {
    for (const mode of ["quick-chat", "search", "quick-chat", "clipboard"] as const) {
      change(mode);
      await new Promise(setImmediate);
      assert.equal(window.alwaysOnTop, mode !== "quick-chat", mode);
    }
  }
  launcher.prepareQuit();
});

for (const source of ["shortcut", "renderer"]) {
  test(`${source} mode switches retain key focus despite a native main-window blur`, async (t) => {
    const { launcher, dock } = trackedLauncher(t);
    await launcher.create();
    const launcherWindow = window;
    const setLevel = launcherWindow.setAlwaysOnTop.bind(launcherWindow);
    launcherWindow.setAlwaysOnTop = (alwaysOnTop) => {
      setLevel(alwaysOnTop);
      if (alwaysOnTop) {
        // macOS main-window status can change while this window remains key.
        setImmediate(() => launcherWindow.emit("blur"));
      }
    };

    for (const mode of ["search", "clipboard"] as const) {
      launcher.openMode("quick-chat");
      await new Promise(setImmediate);
      const generation = launcher.generation();
      if (source === "shortcut") launcher.openMode(mode);
      else launcher.modeChanged(mode);
      await new Promise(setImmediate);
      assert.equal(launcherWindow.alwaysOnTop, true);
      assert.equal(launcherWindow.visible, true);
      assert.equal(launcherWindow.focused, true);
      assert.equal(launcher.generation(), generation);
      assert.equal(dock.visible, true);

      launcherWindow.focused = false;
      launcherWindow.emit("blur");
      assert.equal(launcherWindow.visible, false);
      await new Promise(setImmediate);
      assert.equal(dock.visible, false);
    }
  });
}

test("explicit Launcher show waits for focus capture and repeated calls stay visible", async () => {
  let finishCapture!: (value: boolean) => void;
  let captures = 0;
  const launcher = createLauncherWindow({
    moduleDir: "/unused",
    register() {},
    opened() {},
    focus: {
      snapshot: () => ({
        active: true,
        sourceProcessId: null,
        frontmostProcessId: null,
        generation: 0,
      }),
      begin() {
        captures++;
        return new Promise<boolean>((resolve) => {
          finishCapture = resolve;
        });
      },
      async restore() {
        return true;
      },
      abandon() {},
    },
  });
  await launcher.create();
  const showing = launcher.showMode("quick-chat");
  assert.equal(window.visible, false);
  assert.equal(launcher.snapshot().showPending, true);
  finishCapture(true);
  await showing;
  assert.equal(window.visible, true);
  assert.equal(window.focused, true);
  assert.equal(launcher.snapshot().mode, "quick-chat");
  const shows = window.shows;
  await launcher.showMode("quick-chat");
  assert.equal(window.visible, true);
  assert.equal(window.shows, shows);
  assert.equal(captures, 1);
  await launcher.showMode("search");
  assert.equal(window.visible, true);
  assert.equal(window.alwaysOnTop, true);
  assert.equal(launcher.snapshot().mode, "search");
  launcher.prepareQuit();
});

test("initial and repeated shows wait for native visibility and focus", async (t) => {
  const { launcher } = trackedLauncher(t);
  await launcher.create();
  const launcherWindow = window;
  const nativeShow = launcherWindow.show.bind(launcherWindow);
  const nativeFocus = launcherWindow.focus.bind(launcherWindow);
  launcherWindow.show = () => {
    setImmediate(nativeShow);
  };
  launcherWindow.focus = () => {
    setImmediate(nativeFocus);
  };

  await launcher.showMode("quick-chat");
  assert.equal(launcherWindow.visible, true);
  assert.equal(launcherWindow.focused, true);
  const shows = launcherWindow.shows;

  launcherWindow.focused = false;
  await launcher.showMode("quick-chat");
  assert.equal(launcherWindow.visible, true);
  assert.equal(launcherWindow.focused, true);
  assert.equal(launcherWindow.shows, shows);
});

test("explicit show stops waiting when the presentation is dismissed", async (t) => {
  const { launcher } = trackedLauncher(t);
  await launcher.create();
  const launcherWindow = window;
  launcherWindow.focus = () => {};

  const showing = assert.rejects(launcher.showMode("quick-chat"), /did not become visible/);
  await new Promise(setImmediate);
  launcher.hide();
  await showing;
  assert.equal(launcherWindow.visible, false);
  assert.equal(launcherWindow.focused, false);
});

test("explicit show rejects unready windows and cancelled focus capture", async () => {
  const launcher = createLauncherWindow({
    moduleDir: "/unused",
    register() {},
    opened() {},
    focus: {
      snapshot: () => ({
        active: false,
        sourceProcessId: null,
        frontmostProcessId: null,
        generation: 0,
      }),
      begin: async () => false,
      restore: async () => false,
      abandon() {},
    },
  });
  await assert.rejects(launcher.showMode("quick-chat"), /not ready/);
  await launcher.create();
  await assert.rejects(launcher.showMode("quick-chat"), /did not become visible/);
  assert.equal(window.visible, false);
  assert.equal(await launcher.hideAndRestore(), null);
  launcher.prepareQuit();
});

test("Quick Chat requested before creation joins Dock tracking on its first show", async (t) => {
  const { launcher, dock } = trackedLauncher(t);
  launcher.openMode("quick-chat");
  assert.equal(dock.visible, false);
  await launcher.create();
  await new Promise(setImmediate);
  assert.equal(window.visible, true);
  assert.equal(dock.visible, true);
});

test("Dock activation follows visible Quick Chat across both mode-change paths", async (t) => {
  const { launcher, ordinaryWindows, dock } = trackedLauncher(t);
  await launcher.create();
  launcher.show();
  await new Promise(setImmediate);
  assert.equal(dock.visible, false);

  launcher.openMode("quick-chat");
  await new Promise(setImmediate);
  assert.equal(dock.visible, true);
  assert.equal(ordinaryWindows.focused(), window);
  window.focused = false;
  window.emit("blur");
  assert.equal(window.visible, true);
  assert.equal(dock.visible, true);
  ordinaryWindows.activate();
  assert.equal(window.focused, true);

  launcher.modeChanged("search");
  await new Promise(setImmediate);
  assert.equal(dock.visible, true);
  assert.equal(ordinaryWindows.focused(), undefined);
  const shows = window.shows;
  ordinaryWindows.activate();
  assert.equal(window.shows, shows);

  launcher.modeChanged("quick-chat");
  await new Promise(setImmediate);
  assert.equal(dock.visible, true);
  assert.equal(ordinaryWindows.focused(), window);
  launcher.openMode("clipboard");
  await new Promise(setImmediate);
  assert.equal(dock.visible, true);
  launcher.hide();
  await new Promise(setImmediate);
  assert.equal(dock.visible, false);
});

test("hidden Quick Chat joins on show and leaves tracking on each dismiss path", async (t) => {
  const { launcher, ordinaryWindows, dock } = trackedLauncher(t);
  await launcher.create();
  launcher.hide();
  launcher.modeChanged("quick-chat");
  await new Promise(setImmediate);
  assert.equal(dock.visible, false);

  for (const dismiss of ["shortcut", "close", "explicit-hide", "renderer-hide"]) {
    launcher.show();
    await new Promise(setImmediate);
    assert.equal(dock.visible, true);
    if (dismiss === "shortcut") launcher.openMode("quick-chat");
    else if (dismiss === "close") {
      let prevented = false;
      window.emit("close", {
        preventDefault() {
          prevented = true;
        },
      });
      assert.equal(prevented, true);
    } else if (dismiss === "explicit-hide") launcher.hide();
    else await launcher.dismiss(true);
    await new Promise(setImmediate);
    assert.equal(window.visible, false);
    assert.equal(dock.visible, false);
    const shows = window.shows;
    ordinaryWindows.activate();
    assert.equal(window.shows, shows);
  }
});

test("dismissing Quick Chat preserves Dock for settings and native update windows", async (t) => {
  const { launcher, ordinaryWindows, dock } = trackedLauncher(t);
  await launcher.create();
  const chat = window;
  launcher.openMode("quick-chat");
  const settings = new FakeWindow();
  ordinaryWindows.register(settings as unknown as BrowserWindow);
  settings.show();
  settings.focus();
  launcher.hide();
  await new Promise(setImmediate);
  assert.equal(chat.visible, false);
  assert.equal(dock.visible, true);
  ordinaryWindows.activate();
  assert.equal(settings.focused, true);
  assert.equal(chat.visible, false);

  ordinaryWindows.setNativeWindowVisible(true);
  settings.destroyed = true;
  settings.emit("closed");
  launcher.show();
  launcher.hide();
  await new Promise(setImmediate);
  assert.equal(dock.visible, true);
  ordinaryWindows.setNativeWindowVisible(false);
  await new Promise(setImmediate);
  assert.equal(dock.visible, false);
});

for (const action of ["hide", "renderer-mode", "shortcut-mode"]) {
  test(`Quick Chat ${action} while Dock show is pending preserves the latest intent`, async (t) => {
    const { launcher, dock } = trackedLauncher(t);
    let finish!: () => void;
    dock.show = () =>
      new Promise<void>((resolve) => {
        finish = () => {
          dock.visible = true;
          resolve();
        };
      });
    await launcher.create();
    launcher.openMode("quick-chat");
    if (action === "hide") launcher.hide();
    else if (action === "renderer-mode") launcher.modeChanged("search");
    else launcher.openMode("clipboard");
    finish();
    await new Promise(setImmediate);
    assert.equal(dock.visible, action !== "hide");
    launcher.hide();
    await new Promise(setImmediate);
    assert.equal(dock.visible, false);
  });
}

for (const source of ["shortcut", "renderer"]) {
  test(`${source} return from chat defers a Dock hide that deactivates the app`, async (t) => {
    const { launcher, ordinaryWindows, dock } = trackedLauncher(t);
    await launcher.create();
    const launcherWindow = window;
    let deactivations = 0;
    dock.hide = () => {
      dock.visible = false;
      applicationActive = false;
      launcherWindow.focused = false;
      deactivations++;
      launcherWindow.emit("blur");
    };

    for (const mode of ["search", "clipboard"] as const) {
      launcher.openMode("quick-chat");
      await new Promise(setImmediate);
      const generation = launcher.generation();
      if (source === "shortcut") launcher.openMode(mode);
      else launcher.modeChanged(mode);
      await new Promise(setImmediate);

      assert.equal(launcherWindow.visible, true);
      assert.equal(launcherWindow.focused, true);
      assert.equal(applicationActive, true);
      assert.equal(launcherWindow.alwaysOnTop, true);
      assert.equal(ordinaryWindows.focused(), undefined);
      assert.equal(launcher.generation(), generation);
      assert.equal(dock.visible, true);

      // The user's real app switch still dismisses the transient window.
      applicationActive = false;
      launcherWindow.focused = false;
      launcherWindow.emit("blur");
      await new Promise(setImmediate);
      assert.equal(launcherWindow.visible, false);
      assert.equal(launcherWindow.focused, false);
      assert.equal(applicationActive, false);
      assert.equal(dock.visible, false);
    }
    assert.equal(deactivations, 2);
  });
}
