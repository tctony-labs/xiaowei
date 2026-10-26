import type { ShortcutConfiguration } from "proto-desktop-ts";
import type { createShortcutRegistry } from "./registry";

export type ShortcutValue = string[] | null;
export interface ShortcutConfig {
  main: ShortcutValue;
  clipboard: ShortcutValue;
  quickChat: ShortcutValue;
}

export function shortcutConfig(value: ShortcutConfiguration | undefined): ShortcutConfig {
  return {
    main: value?.main?.keys ?? null,
    clipboard: value?.clipboard?.keys ?? null,
    quickChat: value?.quickChat?.keys ?? null,
  };
}

type Action = keyof ShortcutConfig;
const punctuation: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "Enter",
  Escape: "Escape",
};

export function accelerator(keys: ShortcutValue, platform: string): string | null {
  if (!keys) return null;
  return keys
    .map((code) => {
      if (code === "Meta") return platform === "darwin" ? "Command" : "Super";
      if (code.startsWith("Key")) return code.slice(3);
      if (code.startsWith("Digit")) return code.slice(5);
      return punctuation[code] ?? code;
    })
    .join("+");
}

export function createSettingsShortcuts(
  registry: Pick<ReturnType<typeof createShortcutRegistry>, "register" | "unregister" | "status">,
  platform: string,
  actions: Partial<Record<Action, () => void>>,
) {
  let registered: { shortcut: string; action: Action }[] = [];
  let configured: Partial<Record<Action, string>> = {};

  function replace(config: ShortcutConfig): void {
    const desired = (Object.entries(config) as [Action, ShortcutValue][]).flatMap(
      ([action, keys]) => {
        if (keys && !actions[action]) throw new Error(`Shortcut action unavailable: ${action}`);
        const shortcut = accelerator(keys, platform);
        return shortcut ? [{ shortcut, action }] : [];
      },
    );
    if (new Set(desired.map(({ shortcut }) => shortcut)).size !== desired.length) {
      throw new Error("Duplicate shortcuts");
    }
    const previous = registered;
    for (const { shortcut } of previous) registry.unregister(shortcut);
    registered = [];
    try {
      for (const entry of desired) {
        const handler = actions[entry.action];
        if (!handler || !registry.register(entry.shortcut, handler)) {
          throw new Error(`Shortcut unavailable: ${entry.shortcut}`);
        }
        registered.push(entry);
      }
      configured = Object.fromEntries(desired.map(({ action, shortcut }) => [action, shortcut]));
    } catch (error) {
      for (const { shortcut } of registered) registry.unregister(shortcut);
      registered = [];
      for (const entry of previous) {
        const handler = actions[entry.action];
        if (handler && registry.register(entry.shortcut, handler)) registered.push(entry);
        else console.error(`Unable to restore shortcut: ${entry.shortcut}`);
      }
      throw error;
    }
  }

  return {
    replace,
    getAccelerators(): Partial<Record<Action, string>> {
      return Object.fromEntries(registered.map(({ action, shortcut }) => [action, shortcut]));
    },
    snapshot() {
      return (["main", "clipboard", "quickChat"] as const).map((action) => {
        const shortcut = configured[action] ?? null;
        const status = shortcut ? registry.status(shortcut) : undefined;
        return {
          action,
          accelerator: shortcut,
          registered: status?.registered ?? false,
          state: !shortcut
            ? "disabled"
            : status?.registered
              ? "registered"
              : status?.suspended
                ? "suspended"
                : "unavailable",
        };
      });
    },
    registerInitial(config: ShortcutConfig) {
      if (registered.length) throw new Error("Shortcuts already registered");
      configured = {};
      for (const [action, keys] of Object.entries(config) as [Action, ShortcutValue][]) {
        const shortcut = accelerator(keys, platform);
        if (!shortcut) continue;
        configured[action] = shortcut;
        const handler = actions[action];
        if (handler && registry.register(shortcut, handler)) registered.push({ shortcut, action });
        else console.error(`Launcher shortcut unavailable: ${shortcut} (${action})`);
      }
    },
    close() {
      for (const { shortcut } of registered) registry.unregister(shortcut);
      registered = [];
      configured = {};
    },
  };
}
