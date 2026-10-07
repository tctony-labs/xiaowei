import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

const require = createRequire(new URL("../../package.json", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "llm-startup-"));
const app = Object.assign(new EventEmitter(), {
  setName() {},
  setAppUserModelId() {},
  setPath() {},
  getPath: () => directory,
  getAppPath: () => directory,
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  isPackaged: false,
  getVersion: () => "test",
  quit: () => {
    quit = true;
  },
});
let quit = false;
let failed = false;
let received: unknown;
let receivedAgentRoot: unknown;
let modelDefaultPath: unknown;
const models = { path: join(directory, "models.json"), document: { version: 1, providers: [], defaults: {} } };
let created = false;
const noop = () => {};
const originalConsole = { ...console };
const beforeMonitor = process.listeners("uncaughtExceptionMonitor");
const beforeRejection = process.listeners("unhandledRejection");

mock.module(require.resolve("electron"), {
  exports: {
    app,
    clipboard: {},
    globalShortcut: { unregisterAll: noop },
    protocol: { registerSchemesAsPrivileged: noop },
    screen: {},
    shell: {},
  },
});
mock.module(require.resolve("xiaowei-search"), {
  exports: { initializeLogging: noop, initializeSearch: async () => {} },
});
mock.module(require.resolve("xiaowei-clipboard"), { exports: { initializeLogging: noop } });
mock.module(require.resolve("xiaowei-agent"), { exports: { initializeLogging: noop } });
const replace = (path: string, exports: Record<string, unknown>) =>
  mock.module(new URL(`../../src/main/${path}.ts`, import.meta.url).href, { exports });
replace("app/logging", {
  createLoggers: () => ({ main: { functions: {}, error: noop }, renderer: {} }),
  createNativeLogSink: () => noop,
  attachRendererLogging: noop,
});
replace("app/menu", { installMenu: noop });
replace("app/tray", { createTray: () => ({ close: noop }) });
replace("windows/system-focus", { createSystemFocus: () => ({ abandon: noop }) });
replace("windows/launcher", {
  createLauncherWindow: () => ({
    show: noop,
    hide: noop,
    opened: noop,
    modeChanged: noop,
    openMode: noop,
    prepareQuit: noop,
    create: async () => {
      created = true;
    },
  }),
});
replace("windows/launcher-shortcuts", { positionLauncher: noop });
replace("windows/settings", { createSettingsWindow: () => ({ open: noop }) });
replace("services/shortcuts/shortcuts", {
  createSettingsShortcuts: () => ({ replace: noop, registerInitial: noop, close: noop }),
  shortcutConfig: noop,
});
replace("services/llm/config", {
  loadConfig: async (_env: unknown, path: string) => {
    modelDefaultPath = path;
    if (failed) throw new Error("configuration failure");
    return models;
  },
});
replace("app/gateway", {
  createApplicationGateway: async (...args: unknown[]) => {
    receivedAgentRoot = args[3];
    received = args[5];
    return { settings: { get: async () => ({ shortcuts: {} }) }, close: async () => {} };
  },
});
const { startApplication } = await import("../../src/main/app/bootstrap.ts");

test("bootstrap injects startup models and stops before gateway creation on configuration failure", async () => {
  try {
    const previousRoot = process.env.XIAOWEI_AGENT_HOME;
    process.env.XIAOWEI_AGENT_HOME = join(directory, "module-root");
    try {
      for (const fail of [false, true]) {
        failed = fail;
        received = undefined;
        receivedAgentRoot = undefined;
        created = false;
        quit = false;
        startApplication(directory);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(quit, fail);
        assert.equal(created, !fail);
        assert.equal(received, fail ? undefined : models);
        assert.equal(modelDefaultPath, join(directory, "module-root", "models.json"));
        assert.equal(receivedAgentRoot, fail ? undefined : join(directory, "module-root"));
        app.emit("before-quit", { preventDefault: noop });
        app.removeAllListeners();
      }
    } finally {
      if (previousRoot === undefined) delete process.env.XIAOWEI_AGENT_HOME;
      else process.env.XIAOWEI_AGENT_HOME = previousRoot;
    }
  } finally {
    Object.assign(console, originalConsole);
    for (const listener of process.listeners("uncaughtExceptionMonitor")) {
      if (!beforeMonitor.includes(listener)) process.removeListener("uncaughtExceptionMonitor", listener);
    }
    for (const listener of process.listeners("unhandledRejection")) {
      if (!beforeRejection.includes(listener)) process.removeListener("unhandledRejection", listener);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
