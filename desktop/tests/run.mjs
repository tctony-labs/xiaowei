import { assertProduction, runPnpm, withRustNapiFixtures } from "../../scripts/tests/rust-napi-fixtures.mjs";

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
runPnpm(["--dir", "desktop", "exec", "tsx", "--conditions=source", "--test", "tests/llm/*.test.mjs"]);
runPnpm(["--dir", "desktop", "exec", "vitest", "run"]);

runPnpm(["--filter", "xiaowei-storage", "build:debug"]);
// Storage and LLM use a test-only Rust caller. Other business tests use production addons.
await withRustNapiFixtures(["search"], () => {
  runPnpm([
    "--dir",
    "desktop",
    "exec",
    "tsx",
    "--conditions=source",
    "--test",
    "tests/rust-napi/storage.test.ts",
    "tests/rust-napi/llm.test.mjs",
  ]);
});
runPnpm(["--filter", "xiaowei-clipboard", "build:debug"]);
assertProduction(["storage", "clipboard"]);
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
