import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import type { MenuItemConstructorOptions } from "electron";

const require = createRequire(new URL("../../package.json", import.meta.url));
let menu: MenuItemConstructorOptions[] = [];
let tray: FakeTray;
let imagePath = "";
const icon = {
  isEmpty: () => false,
  resize: () => icon,
  addRepresentation() {},
  toPNG: () => Buffer.alloc(0),
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
        return items;
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
  let settings = 0;
  let quits = 0;
  const showLauncher = () => {
    shown++;
  };
  const controller = createTray({
    resourceDirectory: "/resources/tray",
    showLauncher,
    async openSettings() {
      settings++;
    },
    quit: () => {
      quits++;
    },
  });
  tray.emit("right-click");
  assert.equal(menu[0]?.accelerator, undefined);
  assert.equal(menu[1]?.accelerator, "CommandOrControl+,");
  assert.equal(imagePath, "/resources/tray/logo-clear.png");
  assert.deepEqual(
    menu.filter((entry) => entry.label).map((entry) => entry.label),
    ["搜索", "设置", "退出"],
  );
  assert.equal(menu[0]?.click, showLauncher);
  assert.equal(shown, 0);
  assert.equal(tray.menus, 1);
  tray.emit("click");
  showLauncher();
  assert.equal(shown, 2);
  const openSettings = menu[1]?.click;
  const quit = menu[3]?.click;
  assert.ok(openSettings);
  assert.ok(quit);
  (openSettings as () => void)();
  (quit as () => void)();
  assert.equal(settings, 1);
  assert.equal(quits, 1);
  controller.close();
  controller.close();
  assert.equal(tray.destroys, 1);
});
