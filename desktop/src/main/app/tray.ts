import { join } from "node:path";
import { Menu, nativeImage, Tray } from "electron";

export function createTray(options: {
  resourceDirectory: string;
  development: boolean;
  showLauncher(): void;
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
  const menu = Menu.buildFromTemplate([
    { label: "搜索", click: options.showLauncher },
    {
      label: "设置",
      accelerator: "CommandOrControl+,",
      click: () => {
        void options.openSettings().catch((error: unknown) => console.error("Open settings failed", error));
      },
    },
    { type: "separator" },
    { label: "退出", click: options.quit },
  ]);
  tray.on("click", options.showLauncher);
  tray.on("right-click", () => tray.popUpContextMenu(menu));

  return {
    close() {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
