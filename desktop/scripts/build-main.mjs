import { execFileSync } from "node:child_process";
import { resolveConfig } from "electron-vite";
import { build } from "vite";

execFileSync("pnpm", ["--filter", "xiaowei-gateway", "build"], { stdio: "inherit" });

const { config } = await resolveConfig({}, "serve", "development");
await build(config.main);
await build(config.preload);
