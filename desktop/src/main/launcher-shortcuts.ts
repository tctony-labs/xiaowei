import type { BrowserWindow, Rectangle } from "electron";
import type { LauncherMode } from "../shared/launcher-model";

export function activateLauncherShortcut(
  window: BrowserWindow | undefined,
  currentMode: LauncherMode,
  targetMode: LauncherMode,
  show: () => void,
  opened: (window: BrowserWindow, mode: LauncherMode) => void,
): LauncherMode {
  if (!window || window.isDestroyed()) return currentMode;
  if (currentMode === targetMode && window.isVisible() && window.isFocused()) {
    window.hide();
    return currentMode;
  }
  if (currentMode !== targetMode) {
    window.setSize(800, targetMode === "clipboard" ? 580 : 71);
  }
  opened(window, targetMode);
  show();
  return targetMode;
}

export function positionLauncher(window: BrowserWindow, workArea: Rectangle): void {
  const [width] = window.getSize();
  // Keep every mode at the same upper-screen anchor, independent of the panel height.
  window.setPosition(
    Math.round(workArea.x + (workArea.width - width) / 2),
    Math.round(workArea.y + workArea.height * 0.15),
  );
}

export function showLauncherWindow(window: BrowserWindow | undefined): void {
  if (!window || window.isDestroyed()) return;
  // Hiding preserves the native window position, including manual dragging.
  window.show();
  window.focus();
}
