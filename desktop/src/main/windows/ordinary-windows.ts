import type { BrowserWindow, Dock } from "electron";

type OrdinaryWindow = Pick<
  BrowserWindow,
  "on" | "removeListener" | "isDestroyed" | "isMinimized" | "restore" | "show" | "focus"
>;

export function createOrdinaryWindows(dock?: Pick<Dock, "show" | "hide" | "isVisible">, dockShown?: () => void) {
  const windows = new Map<OrdinaryWindow, { shown: boolean; unregister(): void }>();
  let recent: OrdinaryWindow | undefined;
  let focused: OrdinaryWindow | undefined;
  let closed = false;
  let dockUpdate: Promise<void> | undefined;
  let dockDirty = false;
  let dockRetry: ReturnType<typeof setTimeout> | undefined;

  function candidates() {
    return [...windows].filter(([window, entry]) => entry.shown && !window.isDestroyed()).map(([window]) => window);
  }

  function updateDock(): void {
    if (!dock || closed) return;
    clearTimeout(dockRetry);
    dockRetry = undefined;
    dockDirty = true;
    if (dockUpdate) return;
    dockUpdate = (async () => {
      while (!closed && dockDirty) {
        dockDirty = false;
        const visible = candidates().length > 0;
        if (dock.isVisible() === visible) break;
        if (visible) {
          await dock.show();
          if (!closed) dockShown?.();
        } else {
          dock.hide();
          // Electron ignores hide for one second after show. Recheck current
          // window state on retry instead of treating the void call as success.
          if (dock.isVisible()) {
            dockRetry = setTimeout(updateDock, 1000);
            dockRetry.unref();
          }
          break;
        }
      }
    })()
      .catch((error: unknown) => console.error("Dock update failed", error))
      .finally(() => {
        dockUpdate = undefined;
        if (dockDirty && !closed) updateDock();
      });
  }

  return {
    initialize: updateDock,
    register(window: OrdinaryWindow) {
      if (closed || windows.has(window)) return;
      const shown = () => {
        const entry = windows.get(window);
        if (entry) entry.shown = true;
        updateDock();
      };
      const focus = () => {
        focused = window;
        recent = window;
      };
      const blur = () => {
        if (focused === window) focused = undefined;
      };
      const unregister = () => {
        window.removeListener("show", shown);
        window.removeListener("focus", focus);
        window.removeListener("blur", blur);
        window.removeListener("closed", unregister);
        windows.delete(window);
        if (focused === window) focused = undefined;
        if (recent === window) recent = undefined;
        updateDock();
      };
      windows.set(window, { shown: false, unregister });
      window.on("show", shown);
      window.on("focus", focus);
      window.on("blur", blur);
      window.on("closed", unregister);
    },
    activate() {
      const available = candidates();
      if (!available.length || closed) return;
      const index = focused ? available.indexOf(focused) : -1;
      const target = index >= 0 ? available[(index + 1) % available.length] : (recent ?? available[0]);
      if (!target) return;
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
      focused = target;
      recent = target;
    },
    focused: () => focused,
    close() {
      closed = true;
      clearTimeout(dockRetry);
      dockRetry = undefined;
      for (const entry of [...windows.values()]) entry.unregister();
    },
  };
}
