import { execFileSync } from "node:child_process";
import { root, runPnpm, withRustNapiFixtures } from "../../scripts/tests/rust-napi-fixtures.mjs";

execFileSync("cargo", ["test", "--locked", "-p", "xw-gateway"], { cwd: root, stdio: "inherit" });
runPnpm(["--dir", "gateway/ts", "exec", "tsx", "--conditions=source", "--test", "test/*.test.ts"]);
runPnpm(["--filter", "xiaowei-gateway", "build"]);
runPnpm(["--dir", "gateway/ts", "exec", "node", "--test", "test/worker-built.test.mjs"]);
await withRustNapiFixtures(["search", "clipboard"], () => {
  runPnpm([
    "--dir",
    "gateway/ts",
    "exec",
    "tsx",
    "--conditions=source",
    "--test",
    "test/rust-napi/bridge.test.ts",
    "test/rust-napi/worker.test.ts",
  ]);
});
