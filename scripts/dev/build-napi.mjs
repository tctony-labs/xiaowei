import { spawnSync } from "node:child_process";
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
const result = spawnSync("pnpm", ["exec", "napi", "build", "--platform", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
