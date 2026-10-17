import {
  assertProduction,
  runPnpm,
  rustNapiPrepared,
  withRustNapiFixtures,
} from "../../scripts/tests/rust-napi-fixtures.mjs";

if (!rustNapiPrepared) {
  runPnpm(["--filter", "./crates/*/napi", "--workspace-concurrency=1", "run", "build:debug"]);
}
assertProduction(["rust", "agent"]);

runPnpm(["--dir", "desktop", "exec", "node", "--test", "tests/*.test.mjs"]);
runPnpm([
  "--dir",
  "desktop",
  "exec",
  "tsx",
  "--conditions=source",
  "--experimental-test-module-mocks",
  "--test",
  "tests/main/*.test.ts",
]);
runPnpm(["--dir", "desktop", "build"]);
runPnpm([
  "--dir",
  "desktop",
  "exec",
  "tsx",
  "--conditions=source",
  "--test",
  "tests/llm/*.test.mjs",
]);
runPnpm(["--dir", "desktop", "exec", "vitest", "run"]);
runPnpm(["--filter", "xiaowei-agent", "test:runtime"]);

// Storage, LLM and xwapi use a test-only Rust caller. Other business tests use production addons.
await withRustNapiFixtures(["rust"], () => {
  runPnpm([
    "--dir",
    "desktop",
    "exec",
    "tsx",
    "--conditions=source",
    "--test",
    "tests/rust-napi/storage.test.ts",
    "tests/rust-napi/xwapi.test.ts",
    "tests/rust-napi/llm.test.mjs",
  ]);
});
runPnpm([
  "--dir",
  "desktop",
  "exec",
  "tsx",
  "--conditions=source",
  "--test",
  "tests/rust-napi/business.test.ts",
  "tests/rust-napi/resources.test.ts",
  "tests/rust-napi/usage.test.ts",
  "tests/rust-napi/clipboard-runtime.test.ts",
]);
