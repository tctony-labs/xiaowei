import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// napi builds from each package directory, where dependency source paths can be absolute.
// Embed workspace-relative locations in both debug and release native libraries.
const workspace = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const existing = process.env.CARGO_ENCODED_RUSTFLAGS;
const flags =
  existing === undefined
    ? (process.env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean)
    : existing.split("\x1f").filter(Boolean);
flags.push(`--remap-path-prefix=${workspace}=.`);
const result = spawnSync(
  "pnpm",
  ["exec", "napi", "build", "--platform", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") },
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Strip before tests, ASAR metadata generation and code signing; retain debug-build symbols.
if (process.platform === "darwin" && process.argv.includes("--release")) {
  const { napi } = JSON.parse(readFileSync("package.json", "utf8"));
  const binary = resolve(`${napi.binaryName}.darwin-${process.arch}.node`);
  const before = statSync(binary).size;
  const stripped = spawnSync("xcrun", ["strip", "-x", binary], { stdio: "inherit" });
  if (stripped.error) throw stripped.error;
  if (stripped.status !== 0) process.exit(stripped.status ?? 1);

  console.info(
    `Stripped local symbols: ${napi.binaryName}; ${before} -> ${statSync(binary).size} bytes`,
  );
}
