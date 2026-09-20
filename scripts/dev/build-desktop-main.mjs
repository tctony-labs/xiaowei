import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "electron-vite";
import { build } from "vite";

// Every development launch must load native modules built from the current sources.
const native = spawnSync(
  "pnpm",
  ["--silent", "--filter", "./crates/*/napi", "--workspace-concurrency=1", "run", "build:debug"],
  { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: "inherit" },
);
if (native.error) throw native.error;
if (native.status !== 0) process.exit(native.status ?? 1);

process.chdir(fileURLToPath(new URL("../../desktop", import.meta.url)));

const { config } = await resolveConfig({}, "serve", "development");
await build(config.main);
await build(config.preload);
