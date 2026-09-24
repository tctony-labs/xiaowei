import { fromBinary } from "@bufbuild/protobuf";
import { app } from "electron";
import { requestAccessibilityPermission } from "xiaowei-clipboard";
import { SettingsSnapshotSchema } from "xiaowei-contracts";
import { type ShortcutConfig, shortcutConfig } from "../../app/shortcuts";

export function createSettingsEffects(effects: {
  platform: string;
  setMonitoring(enabled: boolean): Promise<void> | undefined;
  updateShortcuts(config: ShortcutConfig): void;
}) {
  return async (before: Uint8Array, after: Uint8Array): Promise<void> => {
    const previous = fromBinary(SettingsSnapshotSchema, before);
    const next = fromBinary(SettingsSnapshotSchema, after);
    if (effects.platform === "darwin" && !previous.clipboardAutoPaste && next.clipboardAutoPaste) {
      requestAccessibilityPermission();
    }
    if (previous.clipboardEnabled !== next.clipboardEnabled) {
      await effects.setMonitoring(next.clipboardEnabled);
    }
    if (JSON.stringify(previous.shortcuts) !== JSON.stringify(next.shortcuts)) {
      effects.updateShortcuts(shortcutConfig(next.shortcuts));
    }
    if (previous.autostart !== next.autostart) {
      const oldSystemValue = app.getLoginItemSettings().openAtLogin;
      app.setLoginItemSettings({ openAtLogin: next.autostart });
      if (app.isPackaged && app.getLoginItemSettings().openAtLogin !== next.autostart) {
        app.setLoginItemSettings({ openAtLogin: oldSystemValue });
        throw new Error("Unable to change login item setting");
      }
    }
  };
}
