import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "electron-vite";
import { createServer } from "vite";
import { forwardOutput } from "./dev-output.mjs";
import { stopProcessGroup } from "./dev-process.mjs";

const require = createRequire(import.meta.url);
function startWatcher(url) {
  // Isolate nodemon and all application descendants from the terminal process group.
  return spawn(
    process.execPath,
    [
      require.resolve("nodemon/bin/nodemon.js"),
      "--legacy-watch",
      "--watch",
      ".rs",
      "--signal",
      "SIGTERM",
      "--no-stdin",
      "--exec",
      "pnpm dev:main",
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...(process.stdout.isTTY && !process.env.NO_COLOR ? { FORCE_COLOR: "1" } : {}),
        ...process.env,
        ELECTRON_RENDERER_URL: url,
      },
    },
  );
}

export function runSession({
  createRenderer = async () => {
    const { config } = await resolveConfig({}, "serve", "development");
    return createServer(config.renderer);
  },
  launchWatcher = startWatcher,
} = {}) {
  let server;
  let watcher;
  let watcherClosed;
  let stopping = false;
  let stopped;
  let hideStopNotices = false;

  async function start() {
    server = await createRenderer();
    if (stopping) return;
    await server.listen();
    if (stopping) return;
    server.printUrls();
    closeSync(openSync(".rs", "a"));
    watcher = launchWatcher(server.resolvedUrls.local[0]);
    if (watcher.stdout) forwardOutput(watcher.stdout, process.stdout, () => hideStopNotices);
    if (watcher.stderr) forwardOutput(watcher.stderr, process.stderr, () => hideStopNotices);
    watcherClosed = new Promise((resolve) => watcher.once("close", resolve));
    watcher.on("error", (error) => {
      console.error(error);
      void stop(1);
    });
    watcher.on("exit", (code) => {
      if (!stopping) void stop(code ?? 1);
    });
  }

  function stop(code = 0) {
    if (stopped) return stopped;
    stopping = true;
    stopped = (async () => {
      await startup.catch(() => {});
      if (watcher) {
        hideStopNotices = code === 0;
        await stopProcessGroup(watcher, watcherClosed);
      }
      await server?.close();
      process.exitCode = code;
    })()
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      })
      .finally(() => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        process.off("message", onMessage);
        process.off("disconnect", onSignal);
        if (process.connected) process.disconnect();
      });
    return stopped;
  }
  function onSignal() {
    void stop();
  }
  function onMessage(message) {
    if (message?.type === "stop") void stop();
  }
  process.on("message", onMessage);
  process.on("disconnect", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const startup = start();
  startup.catch((error) => {
    console.error(error);
    void stop(1);
  });
  return { ready: startup, stop };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runSession();
