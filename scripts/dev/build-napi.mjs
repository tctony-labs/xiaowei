import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNativeSymbols } from "../release/native-symbols.mjs";

// napi builds from each package directory, where dependency source paths can be absolute.
// Embed workspace-relative locations in both debug and release native libraries.
const workspace = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const existing = process.env.CARGO_ENCODED_RUSTFLAGS;
const flags =
  existing === undefined
    ? (process.env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean)
    : existing.split("\x1f").filter(Boolean);
flags.push(`--remap-path-prefix=${workspace}=.`);
const macRelease = process.platform === "darwin" && process.argv.includes("--release");
const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") };
if (macRelease) {
  // Keep optimized code and the object debug map until dsymutil has collected DWARF.
  env.CARGO_PROFILE_RELEASE_DEBUG = "2";
  env.CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO = "unpacked";
  env.CARGO_PROFILE_RELEASE_STRIP = "none";
}
const result = spawnSync(
  "pnpm",
  ["exec", "napi", "build", "--platform", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env,
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Strip before tests, ASAR metadata generation and code signing; retain debug-build symbols.
if (macRelease) {
  const { napi } = JSON.parse(readFileSync("package.json", "utf8"));
  const binary = resolve(`${napi.binaryName}.darwin-${process.arch}.node`);
  const dsym = `${binary}.dSYM`;
  rmSync(dsym, { recursive: true, force: true });
  const symbols = spawnSync("xcrun", ["dsymutil", binary, "-o", dsym], { stdio: "inherit" });
  if (symbols.error) throw symbols.error;
  if (symbols.status !== 0) process.exit(symbols.status ?? 1);
  const uuid = verifyNativeSymbols(binary, dsym);
  console.info(`Native dSYM generated: ${napi.binaryName}; UUID=${uuid}`);

  const before = statSync(binary).size;
  const stripped = spawnSync("xcrun", ["strip", "-x", binary], { stdio: "inherit" });
  if (stripped.error) throw stripped.error;
  if (stripped.status !== 0) process.exit(stripped.status ?? 1);
  verifyNativeSymbols(binary, dsym);

  console.info(
    `Stripped local symbols: ${napi.binaryName}; ${before} -> ${statSync(binary).size} bytes`,
  );
}
