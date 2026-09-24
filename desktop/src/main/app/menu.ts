import { app, Menu } from "electron";

export function installMenu(openSettings: () => Promise<void>): void {
  const settingsItem = {
    label: "设置…",
    accelerator: "CommandOrControl+,",
    click: () => void openSettings().catch((error: unknown) => console.error("Open settings failed", error)),
  };
  const menu = Menu.buildFromTemplate([
    ...(process.platform === "darwin"
      ? [
          { label: app.name, submenu: [settingsItem, { type: "separator" as const }, { role: "quit" as const }] },
          { label: "文件", submenu: [{ role: "close" as const }] },
        ]
      : [
          {
            label: "文件",
            submenu: [
              settingsItem,
              { type: "separator" as const },
              { role: "close" as const },
              { role: "quit" as const },
            ],
          },
        ]),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);
}
