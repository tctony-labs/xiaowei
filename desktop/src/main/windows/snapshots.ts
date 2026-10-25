import type { BrowserWindow } from "electron";

export function windowSnapshots(
  windows: readonly BrowserWindow[],
  roleFor: (window: BrowserWindow) => string,
) {
  return windows
    .filter((window) => !window.isDestroyed())
    .map((window) => {
      const contents = window.webContents;
      return {
        id: window.id,
        role: roleFor(window),
        title: window.getTitle(),
        visible: window.isVisible(),
        focused: window.isFocused(),
        minimized: window.isMinimized(),
        alwaysOnTop: window.isAlwaysOnTop(),
        bounds: window.getBounds(),
        renderer: {
          id: contents.id,
          destroyed: contents.isDestroyed(),
          loading: !contents.isDestroyed() && contents.isLoading(),
          processId: contents.isDestroyed() ? undefined : contents.getOSProcessId(),
        },
      };
    });
}
