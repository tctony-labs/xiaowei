import type { BrowserWindow, Rectangle, Screen } from "electron";
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

export function showLauncherWindow(
  window: BrowserWindow | undefined,
  screen: Pick<Screen, "getCursorScreenPoint" | "getDisplayNearestPoint" | "getDisplayMatching">,
): void {
  if (!window || window.isDestroyed()) return;
  const targetDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = window.getBounds();
  const currentDisplay = screen.getDisplayMatching(bounds);
  if (currentDisplay.id !== targetDisplay.id) {
    const source = currentDisplay.workArea;
    const target = targetDisplay.workArea;
    const defaultX = Math.round(source.x + (source.width - bounds.width) / 2);
    const defaultY = Math.round(source.y + source.height * 0.15);
    if (bounds.x === defaultX && bounds.y === defaultY) {
      positionLauncher(window, target);
    } else {
      // Scale the horizontal center and top edge so panel height does not affect the anchor.
      const horizontalRatio = (bounds.x + bounds.width / 2 - source.x) / source.width;
      const verticalRatio = (bounds.y - source.y) / source.height;
      window.setPosition(
        Math.round(target.x + target.width * horizontalRatio - bounds.width / 2),
        Math.round(target.y + target.height * verticalRatio),
      );
    }
  }
  // Preserve manual dragging when the cursor remains on the same display.
  window.show();
  window.focus();
}
