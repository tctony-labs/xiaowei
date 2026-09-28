import { join } from "node:path";
import { Menu, nativeImage, Tray } from "electron";

export function createTray(options: {
  resourceDirectory: string;
  showLauncher(): void;
  openSettings(): Promise<unknown>;
  quit(): void;
}) {
  const source = nativeImage.createFromPath(join(options.resourceDirectory, "logo-clear.png"));
  if (source.isEmpty()) throw new Error("Tray image unavailable");
  const icon = source.resize({ width: 16, height: 16 });
  icon.addRepresentation({ scaleFactor: 2, buffer: source.resize({ width: 32, height: 32 }).toPNG() });
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
