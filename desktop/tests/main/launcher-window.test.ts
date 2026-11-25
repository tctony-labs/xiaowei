import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mock, type TestContext, test } from "node:test";
import type { BrowserWindow } from "electron";
import { createFocusSession } from "../../src/main/windows/focus-session";
import { createOrdinaryWindows } from "../../src/main/windows/ordinary-windows";

const require = createRequire(new URL("../../package.json", import.meta.url));
let window: FakeWindow;
let applicationActive = false;
let foreground = process.pid;

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

  constructor(private readonly options: { alwaysOnTop?: boolean; type?: string } = {}) {
    super();
    this.alwaysOnTop = options.alwaysOnTop ?? false;
    window = this;
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
    // Electron's macOS panels take key focus without activating their application.
    if (process.platform !== "darwin" || this.options.type !== "panel") foreground = process.pid;
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
    app: {
      isPackaged: true,
      focus() {
        applicationActive = true;
        foreground = process.pid;
      },
    },
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
    register() {},
    opened() {},
  });
  t.after(() => {
    launcher.prepareQuit();
    ordinaryWindows.close();
  });
  return { launcher, ordinaryWindows, dock };
}

test("the window pin persists across modes and only prevents transient dismissal", async (t) => {
  const { launcher } = trackedLauncher(t);
  await launcher.create();
  const target = window as unknown as BrowserWindow;
  assert.throws(() => launcher.pinState({} as BrowserWindow, true), /Not a launcher window/);
  assert.equal(launcher.pinState(target), false);
  await launcher.showMode("quick-chat");
  assert.equal(window.alwaysOnTop, true);
  assert.equal(launcher.pinState(target, true), true);

  for (const mode of ["quick-chat", "search", "clipboard"] as const) {
    await launcher.showMode(mode);
    assert.equal(launcher.pinState(target), true);
    assert.equal(window.alwaysOnTop, true);
    window.focused = false;
    window.emit("blur");
    launcher.hideTransient();
    assert.equal(window.visible, true);
    assert.equal(window.focused, false);
  }

  await launcher.hideAndRestore();
  assert.equal(window.visible, false);
  assert.equal(launcher.pinState(target), true);
  launcher.setPinned(false);
  launcher.setPinned(true);
  assert.equal(launcher.snapshot().pinned, true);
  assert.equal(window.visible, false);
  assert.equal(window.focused, false);

  await launcher.showMode("quick-chat");
  assert.equal(launcher.pinState(target, false), false);
  assert.equal(window.alwaysOnTop, true);
  window.focused = false;
  window.emit("blur");
  assert.equal(window.visible, false);

  for (const mode of ["search", "clipboard"] as const) {
    await launcher.showMode(mode);
    assert.equal(window.alwaysOnTop, true);
    window.focused = false;
    window.emit("blur");
    assert.equal(window.visible, false);
  }
});

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

test("macOS shortcut toggles take input focus without activating background settings", {
  skip: process.platform !== "darwin",
}, async () => {
  const sourceProcess = process.pid + 1;
  applicationActive = false;
  foreground = sourceProcess;
  let restores = 0;
  let releases = 0;
  const launcher = createLauncherWindow({
    moduleDir: "/unused",
    register() {},
    opened() {},
    focus: createFocusSession({
      ownProcess: process.pid,
      frontmostProcess: () => foreground,
      async capture() {
        return {
          processId: sourceProcess,
          async restore() {
            restores++;
            applicationActive = false;
            foreground = sourceProcess;
            return true;
          },
          async isFrontmost() {
            return foreground === sourceProcess;
          },
          release() {
            releases++;
          },
        };
      },
    }),
  });
  await launcher.create();

  for (let invocation = 0; invocation < 3; invocation++) {
    launcher.openMode("toggle");
    await new Promise(setImmediate);
    assert.equal(window.visible, true);
    assert.equal(window.focused, true);
    assert.equal(foreground, sourceProcess);

    launcher.openMode("toggle");
    await new Promise(setImmediate);
    assert.equal(window.visible, false);
    assert.equal(foreground, sourceProcess);
    assert.equal(restores, invocation + 1);
    assert.equal(releases, invocation + 1);
  }

  launcher.prepareQuit();
});

for (const selection of ["before-create", "before-ready", "shortcut", "renderer"]) {
  test(`unpinned Quick Chat (${selection}) hides on blur without restoring focus`, async () => {
    applicationActive = false;
    const sourceProcess = process.pid + 10000;
    foreground = sourceProcess;
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
    assert.equal(window.alwaysOnTop, true);
    assert.equal(applicationActive, true);
    assert.equal(foreground, process.platform === "darwin" ? sourceProcess : process.pid);
    window.focused = false;
    window.emit("blur");
    assert.equal(window.visible, false);
    assert.equal(abandoned, 1);
    assert.equal(restores, 0);
    await launcher.showMode("quick-chat");
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

test("opening settings hides the unpinned Launcher in every mode", async (t) => {
  const { launcher, ordinaryWindows } = trackedLauncher(t);
  await launcher.create();
  await launcher.dismiss(false);

  for (const mode of ["search", "clipboard", "quick-chat"] as const) {
    launcher.openMode(mode);
    await new Promise(setImmediate);
    assert.equal(window.visible, true, mode);

    launcher.hideTransient();
    assert.equal(window.visible, false, mode);
  }

  assert.equal(ordinaryWindows.snapshot().ordinaryWindowCount, 0);
});

test("the Launcher stays above ordinary windows through both mode-change paths", async () => {
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
      assert.equal(window.alwaysOnTop, true, mode);
    }
  }
  launcher.prepareQuit();
});

for (const source of ["shortcut", "renderer"]) {
  test(`${source} mode switches retain key focus despite a native main-window blur`, async (t) => {
    const { launcher, dock } = trackedLauncher(t);
    await launcher.create();
    const launcherWindow = window;

    for (const mode of ["search", "clipboard"] as const) {
      launcher.openMode("quick-chat");
      await new Promise(setImmediate);
      const generation = launcher.generation();
      if (source === "shortcut") launcher.openMode(mode);
      else launcher.modeChanged(mode);
      // macOS main-window status can change while this window remains key.
      launcherWindow.emit("blur");
      assert.equal(launcherWindow.alwaysOnTop, true);
      assert.equal(launcherWindow.visible, true);
      assert.equal(launcherWindow.focused, true);
      assert.equal(launcher.generation(), generation);
      assert.equal(dock.visible, false);

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
  await launcher.dismiss(false);
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

test("unpinned Quick Chat requested before creation opens without showing the Dock", async (t) => {
  const { launcher, ordinaryWindows, dock } = trackedLauncher(t);
  dock.show = async () => {
    dock.visible = true;
    // The macOS activation policy change can take focus from the new panel.
    await new Promise(setImmediate);
    window.focused = false;
    window.emit("blur");
  };

  launcher.openMode("quick-chat");
  assert.equal(dock.visible, false);
  await launcher.create();
  await new Promise(setImmediate);
  assert.equal(window.visible, true);
  assert.equal(window.focused, true);
  assert.equal(dock.visible, false);
  assert.equal(ordinaryWindows.snapshot().ordinaryWindowCount, 0);
});

test("the Launcher stays outside Dock visibility and activation in every mode", async (t) => {
  const { launcher, ordinaryWindows, dock } = trackedLauncher(t);
  await launcher.create();

  for (const pinned of [false, true]) {
    launcher.setPinned(pinned);
    for (const mode of ["quick-chat", "search", "clipboard"] as const) {
      await launcher.showMode(mode);
      await new Promise(setImmediate);

      const { ordinaryWindowCount, desiredVisible } = ordinaryWindows.snapshot();
      assert.equal(ordinaryWindowCount, 0, mode);
      assert.equal(desiredVisible, false, mode);
      assert.equal(dock.visible, false, mode);
      window.focused = false;
      window.emit("blur");
      assert.equal(window.visible, pinned, mode);
      ordinaryWindows.activate();
      assert.equal(window.focused, false, mode);
      assert.equal(dock.visible, false, mode);
    }
  }
});

test("pinned Quick Chat still closes through every explicit dismiss path", async (t) => {
  const { launcher, ordinaryWindows, dock } = trackedLauncher(t);
  await launcher.create();
  await launcher.dismiss(false);
  launcher.setPinned(true);
  launcher.modeChanged("quick-chat");
  await new Promise(setImmediate);
  assert.equal(dock.visible, false);

  for (const dismiss of ["shortcut", "close", "explicit-hide", "renderer-hide"]) {
    launcher.show();
    await new Promise(setImmediate);
    assert.equal(dock.visible, false);
    if (dismiss === "shortcut") launcher.openMode("quick-chat");
    else if (dismiss === "close") {
      let prevented = false;
      window.emit("close", {
        preventDefault() {
          prevented = true;
        },
      });
      assert.equal(prevented, true);
    } else if (dismiss === "explicit-hide") await launcher.dismiss(false);
    else await launcher.dismiss(true);
    await new Promise(setImmediate);
    assert.equal(window.visible, false);
    assert.equal(dock.visible, false);
    const shows = window.shows;
    ordinaryWindows.activate();
    assert.equal(window.shows, shows);
  }
});

test("closing settings and updates hides the Dock while the Launcher remains visible", async (t) => {
  const { launcher, ordinaryWindows, dock } = trackedLauncher(t);
  await launcher.create();
  const chat = window;
  launcher.setPinned(true);
  await launcher.showMode("quick-chat");

  const settings = new FakeWindow();
  ordinaryWindows.register(settings as unknown as BrowserWindow);
  settings.show();
  settings.focus();
  await new Promise(setImmediate);
  assert.equal(dock.visible, true);
  assert.equal(ordinaryWindows.snapshot().ordinaryWindowCount, 1);
  ordinaryWindows.activate();
  assert.equal(settings.focused, true);

  ordinaryWindows.setNativeWindowVisible(true);
  settings.destroyed = true;
  settings.emit("closed");
  await new Promise(setImmediate);
  assert.equal(dock.visible, true);
  assert.equal(ordinaryWindows.snapshot().ordinaryWindowCount, 0);

  ordinaryWindows.setNativeWindowVisible(false);
  await new Promise(setImmediate);
  assert.equal(dock.visible, false);
  assert.equal(chat.visible, true);
});
