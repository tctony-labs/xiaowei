const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const { Worker } = require("node:worker_threads");
const { SparkleUpdater } = require("../index.js");

test("Sparkle refuses an unconfigured Node process without loading the framework or invoking the callback", () => {
  let called = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(
      () =>
        SparkleUpdater.open("/missing/Sparkle.framework", () => {
          called = true;
        }),
      /Missing SUFeedURL|only supported on macOS/,
    );
  }
  assert.equal(called, false);
});

test("Sparkle rejects initialization from a Node worker before accessing Cocoa", {
  skip: process.platform !== "darwin",
  timeout: 5000,
}, async () => {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { SparkleUpdater } = require(workerData);
    try {
      SparkleUpdater.open("/missing/Sparkle.framework", () => {});
      parentPort.postMessage("Unexpected initialization");
    } catch (error) {
      parentPort.postMessage(error.message);
    }
  `,
    { eval: true, workerData: require.resolve("../index.js") },
  );
  try {
    const [message] = await once(worker, "message");
    assert.match(message, /macOS main thread/);
  } finally {
    await worker.terminate();
  }
});
