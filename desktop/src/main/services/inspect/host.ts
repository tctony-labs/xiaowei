import { randomUUID } from "node:crypto";
import type { LauncherMode } from "../../../shared/launcher-model";
import {
  INSPECT_PROTOCOL,
  INSPECT_VERSION,
  type InspectMethod,
  type InspectSource,
} from "./protocol.ts";
import { startInspectServer } from "./server.ts";
import { resolveInspectSource } from "./target.ts";

export async function startApplicationInspect(options: {
  source: InspectSource;
  version: string;
  appPath: string;
  dataPath: string;
  status(): unknown;
  windows(): unknown;
  shortcuts(): unknown;
  showLauncher(mode: LauncherMode): Promise<void>;
  hideLauncher(): Promise<boolean | null>;
}) {
  const instanceId = randomUUID();
  const source = await resolveInspectSource(options.source);
  const startedAtMs = Math.round(Date.now() - process.uptime() * 1000);
  const identity = () => ({
    instanceId,
    pid: process.pid,
    source,
    appPath: options.appPath,
    dataPath: options.dataPath,
    executable: process.execPath,
    cwd: process.cwd(),
    version: options.version,
    startedAtMs,
  });
  const methods = new Map<string, InspectMethod>();
  const status = () => ({
    observedAtMs: Date.now(),
    instance: identity(),
    state: options.status(),
    windows: options.windows(),
    shortcuts: options.shortcuts(),
  });

  methods.set("system.identify", {
    description: "Read the running instance identity",
    mutates: false,
    params: {},
    run: identity,
  });
  methods.set("system.capabilities", {
    description: "Discover this instance's methods and parameters",
    mutates: false,
    params: {},
    run: () => ({
      protocol: INSPECT_PROTOCOL,
      version: INSPECT_VERSION,
      instance: identity(),
      methods: [...methods].map(([name, { description, mutates, params }]) => ({
        name,
        description,
        mutates,
        params,
      })),
    }),
  });
  methods.set("app.status", {
    description: "Read application, window, Dock, Launcher and shortcut state",
    mutates: false,
    params: {},
    run: status,
  });
  methods.set("window.list", {
    description: "List native windows, including hidden windows",
    mutates: false,
    params: {},
    run: options.windows,
  });
  methods.set("shortcut.list", {
    description: "Read configured shortcuts, system registrations and menu suspension",
    mutates: false,
    params: {},
    run: options.shortcuts,
  });
  methods.set("launcher.show", {
    description: "Show and focus Launcher in a mode; repeated calls keep it visible",
    mutates: true,
    params: {
      mode: {
        type: "string",
        required: true,
        values: ["search", "clipboard", "quick-chat"],
      },
    },
    async run({ mode }) {
      await options.showLauncher(mode as LauncherMode);
      return status();
    },
  });
  methods.set("launcher.hide", {
    description: "Hide Launcher and restore its focus source",
    mutates: true,
    params: {},
    async run() {
      const focusRestored = await options.hideLauncher();
      return { focusRestored, ...status() };
    },
  });
  return startInspectServer({ source, methods });
}
