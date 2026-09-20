import { fileURLToPath } from "node:url";
import { resolveConfig } from "electron-vite";
import { build } from "vite";

process.chdir(fileURLToPath(new URL("../desktop", import.meta.url)));

const { config } = await resolveConfig({}, "serve", "development");
await build(config.main);
await build(config.preload);
