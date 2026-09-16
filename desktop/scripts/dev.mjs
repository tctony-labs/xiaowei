import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { resolveConfig } from "electron-vite";
import { createServer } from "vite";

const { config } = await resolveConfig({}, "serve", "development");
const server = await createServer(config.renderer);
await server.listen();
server.printUrls();
closeSync(openSync(".rs", "a"));

const watcher = spawn(
  "pnpm",
  ["exec", "nodemon", "--legacy-watch", "--watch", ".rs", "--signal", "SIGTERM", "--exec", "pnpm dev:main"],
  {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RENDERER_URL: server.resolvedUrls.local[0] },
  },
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => watcher.kill(signal));
}
watcher.on("error", async (error) => {
  console.error(error);
  await server.close();
  process.exitCode = 1;
});
watcher.on("exit", async (code) => {
  await server.close();
  process.exitCode = code ?? 0;
});
