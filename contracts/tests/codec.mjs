import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temp = mkdtempSync(join(tmpdir(), "contracts-codec-"));
const tsx = join(root, "contracts/ts/node_modules/.bin/tsx");
const run = (cmd, args, cwd = root) => {
  console.log(`[contracts] Running ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", timeout: 10 * 60_000, killSignal: "SIGKILL" });
};

try {
  run("node", ["--test", "contracts/ts/test/proto-selection.test.mjs"]);
  run(tsx, ["--test", "contracts/ts/test/codec-process.test.ts"]);
  run("cargo", ["build", "--locked", "-p", "xw-contracts", "--example", "codec"]);
  run("go", ["build", "-mod=readonly", "-o", join(temp, "codec-go"), "./cmd/codec"], join(root, "contracts/go"));
  console.log("[contracts] Resolving Cargo target directory");
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--format-version=1"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    }),
  );
  run(tsx, [
    "contracts/ts/test/codec.ts",
    join(metadata.target_directory, "debug/examples/codec"),
    join(temp, "codec-go"),
  ]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
