import { resolveConfig } from "electron-vite";
import { build } from "vite";

const { config } = await resolveConfig({}, "serve", "development");
await build(config.main);
await build(config.preload);
