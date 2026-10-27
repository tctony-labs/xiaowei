import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import artifacts from "../tests/bundled-worker.cjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

function snapshot(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true })
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      const stat = statSync(path, { bigint: true });
      if (!stat.isFile()) return [];
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      return [{ name, hash, mtime: stat.mtimeNs }];
    });
}

test("validation build preserves development artifacts and provides a separate worker", () => {
  const development = join(root, "desktop/out");
  const before = snapshot(development);
  execFileSync("pnpm", ["--dir", "desktop", "build:test"], { cwd: root, stdio: "pipe" });
  assert.deepEqual(snapshot(development), before);
  assert.ok(existsSync(artifacts.bundledWorkerUrl));
  assert.equal(artifacts.bundledMainDir, join(root, "desktop/out-test/main"));
});

test("ESM and CommonJS consumers use the same explicit isolated worker directory", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import assert from "node:assert/strict";
        import { createRequire } from "node:module";
        import artifacts from "./scripts/tests/bundled-worker.cjs";

        const require = createRequire(import.meta.url);
        const commonjs = require("./scripts/tests/bundled-worker.cjs");
        assert.equal(artifacts.bundledMainDir, process.env.XIAOWEI_TEST_BUNDLED_MAIN_DIR);
        assert.equal(artifacts.bundledWorkerUrl.href, commonjs.bundledWorkerUrl.href);
        console.log(artifacts.bundledWorkerUrl.href);
      `,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, XIAOWEI_TEST_BUNDLED_MAIN_DIR: join(root, "target/worker-fixture") },
    },
  );
  assert.match(output, /target\/worker-fixture\/llm-worker\.js/);
});
