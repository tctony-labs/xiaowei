import type { GlobalShortcut } from "electron";

export function createShortcutRegistry(native: Pick<GlobalShortcut, "register" | "unregister">) {
  const bindings = new Map<string, () => void>();
  let menuActive = false;

  return {
    register(accelerator: string, action: () => void): boolean {
      if (bindings.has(accelerator) || !native.register(accelerator, action)) return false;
      bindings.set(accelerator, action);
      if (menuActive) native.unregister(accelerator);
      return true;
    },
    unregister(accelerator: string): void {
      native.unregister(accelerator);
      bindings.delete(accelerator);
    },
    suspendForMenu() {
      if (menuActive) throw new Error("Shortcut menu handoff already active");
      menuActive = true;
      const entries = [...bindings].map(([accelerator, action]) => {
        native.unregister(accelerator);
        return {
          accelerator,
          invoke() {
            if (bindings.get(accelerator) !== action) return;
            action();
          },
        };
      });
      let restored = false;

      return {
        entries,
        restore() {
          if (restored) return;
          restored = true;
          menuActive = false;
          for (const [accelerator, action] of bindings) {
            const success = native.register(accelerator, action);
            if (!success) console.error(`Unable to restore shortcut: ${accelerator}`);
          }
        },
      };
    },
    close(): void {
      for (const accelerator of bindings.keys()) native.unregister(accelerator);
      bindings.clear();
    },
  };
}
