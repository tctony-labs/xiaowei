import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourceLocationPlugin } from "../vite.ts";
import { createLoggedWorker } from "../worker.ts";

test("worker console preserves source, levels and multiline output without using business messages", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xiaowei-worker-log-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const code = [
    `import { initializeWorkerLogging } from ${JSON.stringify(new URL("../worker.ts", import.meta.url).href)};`,
    'import { parentPort } from "node:worker_threads";',
    "initializeWorkerLogging();",
    'console.info("hello %s %o", "world", { count: 2 });',
    'console.warn("first\\nsecond");',
    'console.error(new Error("worker-failure"));',
    'console.debug("debug-marker");',
    'console.trace("trace-marker");',
    'process.stdout.write("raw-output\\n");',
    'process.stderr.write("raw-error\\n");',
    'parentPort.postMessage("business-message");',
  ].join("\n");
  const id = fileURLToPath(new URL("./fixtures/worker.ts", import.meta.url));
  const transformed = sourceLocationPlugin().transform(code, id).code;
  const runtime = fileURLToPath(new URL("../runtime.ts", import.meta.url));
  const filename = join(directory, "worker.mjs");
  const runnable = transformed.replace(JSON.stringify(runtime), JSON.stringify(pathToFileURL(runtime).href));
  writeFileSync(filename, runnable);
  const logs = [];
  const sink = Object.fromEntries(
    ["info", "warn", "error", "debug"].map((level) => [level, (message) => logs.push({ level, message })]),
  );
  const worker = createLoggedWorker("fixture", pathToFileURL(filename), {}, sink);
  t.after(() => worker.terminate());
  const messages = [];
  worker.on("message", (message) => messages.push(message));
  assert.deepEqual(await once(worker, "exit"), [0]);
  assert.deepEqual(messages, ["business-message"]);
  assert.equal(logs.length, 7);
  assert.deepEqual(
    logs.find((log) => log.message.includes("hello world")),
    {
      level: "info",
      message: "[worker.fixture] [packages/source-log/test/fixtures/worker.ts:4] hello world { count: 2 }",
    },
  );
  assert.match(logs.find((log) => log.level === "warn").message, /worker.ts:5\] first\nsecond$/);
  assert.match(logs.find((log) => log.message.includes("worker-failure")).message, /worker.ts:6\] Error/);
  assert.equal(logs.filter((log) => log.level === "debug").length, 2);
  assert.match(logs.find((log) => log.message.includes("trace-marker")).message, /Trace:.*worker.ts:8/);
  assert.ok(logs.some((log) => log.level === "info" && log.message === "[worker.fixture] raw-output"));
  assert.ok(logs.some((log) => log.level === "error" && log.message === "[worker.fixture] raw-error"));
  assert.ok(logs.every((log) => !log.message.includes("xiaowei-log:")));
});

test("worker stream collection flushes trailing text and leaves malformed frames readable", async () => {
  const code = 'process.stdout.write("\\u001exiaowei-log:not-json\\ntail");';
  const lines = [];
  const sink = { info: (line) => lines.push(line), warn() {}, error() {}, debug() {} };
  const worker = createLoggedWorker("raw", new URL(`data:text/javascript,${encodeURIComponent(code)}`), {}, sink);
  assert.deepEqual(await once(worker, "exit"), [0]);
  assert.deepEqual(lines, ["[worker.raw] \u001exiaowei-log:not-json", "[worker.raw] tail"]);
});
