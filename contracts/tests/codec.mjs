import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temp = mkdtempSync(join(tmpdir(), "contracts-codec-"));
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
try {
  run("node", ["--test", "contracts/ts/test/proto-selection.test.mjs"]);
  run("cargo", ["build", "--locked", "-p", "xw-contracts", "--example", "codec"]);
  run("go", ["build", "-mod=readonly", "-o", join(temp, "codec-go"), "./cmd/codec"], join(root, "contracts/go"));
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--format-version=1"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  run(join(root, "contracts/ts/node_modules/.bin/tsx"), [
    "contracts/ts/test/codec.ts",
    join(metadata.target_directory, "debug/examples/codec"),
    join(temp, "codec-go"),
  ]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
