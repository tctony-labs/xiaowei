import { join } from "node:path";
import { Menu, nativeImage, Tray } from "electron";

export function createTray(options: {
  resourceDirectory: string;
  development: boolean;
  showLauncher(): void;
  openClipboard(): void;
  openQuickChat(): void;
  getMenuAccelerators(): { main?: string; clipboard?: string; quickChat?: string };
  suspendShortcutsForMenu(): {
    entries: { accelerator: string; invoke(): void }[];
    restore(): void;
  };
  openSettings(): Promise<unknown>;
  quit(): void;
}) {
  const iconName = options.development ? "tray-dev.png" : "tray.png";
  const icon = nativeImage.createFromPath(join(options.resourceDirectory, iconName));
  if (icon.isEmpty()) throw new Error("Tray image unavailable");
  icon.setTemplateImage(true);

  const tray = new Tray(icon);
  tray.setToolTip("XiaoWei");
  tray.setIgnoreDoubleClickEvents(true);
  let menu: Menu | undefined;
  let handoff: ReturnType<typeof options.suspendShortcutsForMenu> | undefined;

  function prepareMenu(): void {
    const accelerators = options.getMenuAccelerators();
    const visibleAccelerators = new Set(Object.values(accelerators));
    menu = Menu.buildFromTemplate([
      { label: "搜索", accelerator: accelerators.main, click: options.showLauncher },
      { label: "剪贴板", accelerator: accelerators.clipboard, click: options.openClipboard },
      { label: "快速对话", accelerator: accelerators.quickChat, click: options.openQuickChat },
      { type: "separator" },
      {
        label: "设置",
        accelerator: "CommandOrControl+,",
        click: () => {
          void options.openSettings().catch((error: unknown) => console.error("Open settings failed", error));
        },
      },
      { type: "separator" },
      { label: "退出", click: options.quit },
      ...(handoff?.entries ?? [])
        .filter((entry) => !visibleAccelerators.has(entry.accelerator))
        .map((entry) => ({
          label: entry.accelerator,
          accelerator: entry.accelerator,
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: entry.invoke,
        })),
    ]);
    menu.on("menu-will-close", () => {
      handoff?.restore();
      handoff = undefined;
    });
  }

  tray.on("click", options.showLauncher);
  tray.on("right-click", () => {
    if (handoff) return;
    handoff = options.suspendShortcutsForMenu();
    try {
      prepareMenu();
      tray.popUpContextMenu(menu);
    } catch (error) {
      handoff?.restore();
      handoff = undefined;
      throw error;
    }
  });

  return {
    close() {
      if (!tray.isDestroyed()) tray.destroy();
      handoff?.restore();
      handoff = undefined;
    },
  };
}
