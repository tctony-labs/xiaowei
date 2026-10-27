const { execFileSync } = require("node:child_process");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const root = resolve(__dirname, "../..");
const bundledMainDir = resolve(
  process.env.XIAOWEI_TEST_BUNDLED_MAIN_DIR ?? join(root, "desktop/out-test/main"),
);
const bundledWorkerUrl = pathToFileURL(join(bundledMainDir, "llm-worker.js"));

function prepareBundledWorker() {
  // An outer test runner can pass its freshly built output to nested test runners.
  if (process.env.XIAOWEI_TEST_BUNDLED_MAIN_DIR) return;

  execFileSync("pnpm", ["--dir", "desktop", "build:test"], {
    cwd: root,
    stdio: "inherit",
  });
  process.env.XIAOWEI_TEST_BUNDLED_MAIN_DIR = bundledMainDir;
}

module.exports = { bundledMainDir, bundledWorkerUrl, prepareBundledWorker };
