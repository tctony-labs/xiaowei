import type { BrowserWindow, Dock } from "electron";

type OrdinaryWindow = Pick<
  BrowserWindow,
  "on" | "removeListener" | "isDestroyed" | "isMinimized" | "restore" | "show" | "focus"
>;

export function createOrdinaryWindows(dock?: Pick<Dock, "show" | "hide" | "isVisible">) {
  const windows = new Map<OrdinaryWindow, { shown: boolean; unregister(): void }>();
  let recent: OrdinaryWindow | undefined;
  let focused: OrdinaryWindow | undefined;
  let closed = false;
  let dockUpdate: Promise<void> | undefined;
  let dockDirty = false;

  function candidates() {
    return [...windows].filter(([window, entry]) => entry.shown && !window.isDestroyed()).map(([window]) => window);
  }

  function updateDock(): void {
    if (!dock || closed) return;
    dockDirty = true;
    if (dockUpdate) return;
    dockUpdate = (async () => {
      while (!closed && dockDirty) {
        dockDirty = false;
        const visible = candidates().length > 0;
        if (dock.isVisible() === visible) break;
        if (visible) await dock.show();
        else {
          dock.hide();
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
      for (const entry of [...windows.values()]) entry.unregister();
    },
  };
}
