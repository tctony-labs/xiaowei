import type { BrowserWindow } from "electron";
import type { LauncherMode } from "../shared/launcher-api";

export function activateLauncherShortcut(
  window: BrowserWindow | undefined,
  currentMode: LauncherMode,
  targetMode: LauncherMode,
  show: () => void,
): LauncherMode {
  if (!window || window.isDestroyed()) return currentMode;
  if (currentMode === targetMode && window.isVisible() && window.isFocused()) {
    window.hide();
    return currentMode;
  }
  if (currentMode !== targetMode) {
    window.setSize(800, targetMode === "clipboard" ? 580 : 71);
  }
  window.webContents.send("launcher:open", targetMode);
  show();
  return targetMode;
}
