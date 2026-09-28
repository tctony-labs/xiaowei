import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import type { MenuItemConstructorOptions } from "electron";

const require = createRequire(new URL("../../package.json", import.meta.url));
let menu: MenuItemConstructorOptions[] = [];
let tray: FakeTray;
let menuEvents: EventEmitter;
let imagePath = "";
const icon = {
  isEmpty: () => false,
  setTemplateImage() {},
};

class FakeTray extends EventEmitter {
  destroyed = false;
  destroys = 0;
  menus = 0;

  constructor() {
    super();
    tray = this;
  }

  setToolTip() {}
  setIgnoreDoubleClickEvents() {}
  popUpContextMenu() {
    this.menus++;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.destroys++;
  }
}

mock.module(require.resolve("electron"), {
  exports: {
    Tray: FakeTray,
    Menu: {
      buildFromTemplate: (items: MenuItemConstructorOptions[]) => {
        menu = items;
        menuEvents = new EventEmitter();
        return menuEvents;
      },
    },
    nativeImage: {
      createFromPath: (path: string) => {
        imagePath = path;
        return icon;
      },
    },
  },
});

const { createTray } = await import("../../src/main/app/tray.ts");

test("Tray left click and Search share one action, right click only opens the menu", async () => {
  let shown = 0;
  let restored = 0;
  let clipboard = 0;
  let quickChat = 0;
  let settings = 0;
  let quits = 0;
  const showLauncher = () => {
    shown++;
  };
  const controller = createTray({
    resourceDirectory: "/resources/tray",
    development: true,
    showLauncher,
    openClipboard: () => clipboard++,
    openQuickChat: () => quickChat++,
    getMenuAccelerators: () => ({ main: "Command+Space", clipboard: "Command+Shift+X" }),
    suspendShortcutsForMenu: () => ({
      entries: [
        { accelerator: "Command+Space", invoke: showLauncher },
        { accelerator: "Control+Alt+F9", invoke: showLauncher },
      ],
      restore: () => restored++,
    }),
    async openSettings() {
      settings++;
    },
    quit: () => {
      quits++;
    },
  });
  tray.emit("right-click");
  assert.equal(menu[0]?.accelerator, "Command+Space");
  assert.equal(menu[1]?.accelerator, "Command+Shift+X");
  assert.equal(menu[2]?.accelerator, undefined);
  assert.equal(menu.filter((entry) => entry.accelerator === "Command+Space").length, 1);
  assert.equal(menu[7]?.accelerator, "Control+Alt+F9");
  assert.equal(menu[7]?.visible, false);
  assert.equal(menu[7]?.acceleratorWorksWhenHidden, true);
  assert.equal(menu[7]?.click, showLauncher);
  assert.equal(menu[4]?.accelerator, "CommandOrControl+,");
  assert.equal(menu[3]?.type, "separator");
  assert.equal(imagePath, "/resources/tray/tray-dev.png");
  assert.deepEqual(
    menu.filter((entry) => entry.label && entry.visible !== false).map((entry) => entry.label),
    ["搜索", "剪贴板", "快速对话", "设置", "退出"],
  );
  const search = menu[0]?.click;
  const openClipboard = menu[1]?.click;
  const openQuickChat = menu[2]?.click;
  assert.ok(search);
  assert.ok(openClipboard);
  assert.ok(openQuickChat);
  assert.equal(shown, 0);
  assert.equal(tray.menus, 1);
  tray.emit("click");
  (search as () => void)();
  assert.equal(shown, 2);
  const openSettings = menu[4]?.click;
  const quit = menu[6]?.click;
  assert.ok(openSettings);
  assert.ok(quit);
  (openSettings as () => void)();
  (quit as () => void)();
  (openClipboard as () => void)();
  (openQuickChat as () => void)();
  assert.equal(clipboard, 1);
  assert.equal(quickChat, 1);
  assert.equal(settings, 1);
  assert.equal(quits, 1);
  menuEvents.emit("menu-will-close");
  assert.equal(restored, 1);
  controller.close();
  controller.close();
  assert.equal(restored, 1);
  assert.equal(tray.destroys, 1);
});
