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
const models: unknown[] = [];
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
const replace = (path: string, exports: Record<string, unknown>) =>
  mock.module(new URL(`../../src/main/${path}.ts`, import.meta.url).href, { exports });
replace("app/logging", {
  createLoggers: () => ({ main: { functions: {}, error: noop }, renderer: {} }),
  createNativeLogSink: () => noop,
  attachRendererLogging: noop,
});
replace("app/menu", { installMenu: noop });
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
replace("services/llm/startup-config", {
  loadStartupModels: async () => {
    if (failed) throw new Error("configuration failure");
    return models;
  },
});
replace("app/gateway", {
  createApplicationGateway: async (...args: unknown[]) => {
    received = args[4];
    return { settings: { get: async () => ({ shortcuts: {} }) }, close: async () => {} };
  },
});
const { startApplication } = await import("../../src/main/app/bootstrap.ts");

test("bootstrap injects startup models and stops before gateway creation on configuration failure", async () => {
  try {
    for (const fail of [false, true]) {
      failed = fail;
      received = undefined;
      created = false;
      quit = false;
      startApplication(directory);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(quit, fail);
      assert.equal(created, !fail);
      assert.equal(received, fail ? undefined : models);
      app.emit("before-quit", { preventDefault: noop });
      app.removeAllListeners();
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
