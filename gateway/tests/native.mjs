// Build test-only addons in isolation and restore normal generated package outputs afterwards.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const run = (args) => execFileSync("pnpm", args, { cwd: root, stdio: "inherit" });
const packages = ["search", "clipboard"];
let failure;
run(["--filter", "xiaowei-storage", "build:debug"]);
try {
  for (const name of packages) {
    run([
      "--filter",
      `xiaowei-${name}`,
      "build:debug",
      "--features",
      "gateway-fixtures",
      "--output-dir",
      `../../../gateway/tests/native/${name}`,
    ]);
  }
  run(["--dir", "gateway/ts", "exec", "tsx", "--test", "test/native/bridge.test.ts", "test/native/storage.test.ts"]);
} catch (error) {
  failure = error;
} finally {
  for (const name of packages) {
    try {
      run(["--filter", `xiaowei-${name}`, "build:debug"]);
    } catch (error) {
      failure ??= error;
    }
  }
}
if (failure) throw failure;
execFileSync(process.execPath, ["gateway/tests/production.cjs"], { cwd: root, stdio: "inherit" });

run(["--filter", "xiaowei-gateway", "build"]);
run(["--dir", "gateway/ts", "exec", "tsx", "--test", "test/native/business.test.ts"]);

run([
  "--dir",
  "gateway/ts",
  "exec",
  "tsx",
  "--experimental-test-module-mocks",
  "--test",
  "test/native/lifecycle.test.ts",
  "test/native/selection.test.ts",
  "test/native/system.test.ts",
]);
