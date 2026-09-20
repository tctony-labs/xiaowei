import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "electron-vite";
import { build, createServer } from "vite";

process.chdir(fileURLToPath(new URL("../desktop", import.meta.url)));

// Runs Vite only, never Electron. OS and dependency caches are not cleared.
const directory = await mkdtemp(join(tmpdir(), "xiaowei-log-benchmark-"));
const results = [];
try {
  for (const enabled of [false, true, true, false, false, true]) {
    process.env.XIAOWEI_LOG_SOURCE = enabled ? "1" : "0";
    const { config } = await resolveConfig({}, "build", "production");
    const start = performance.now();
    for (const target of ["main", "preload", "renderer"]) {
      await build({
        ...config[target],
        logLevel: "silent",
        build: { ...config[target].build, outDir: join(directory, target) },
      });
    }
    const buildMs = performance.now() - start;
    const main = await readFile(join(directory, "main/index.js"), "utf8");
    assert.equal(main.includes("desktop/src/main/index.ts:"), enabled);
    const development = await resolveConfig({}, "serve", "development");
    const devStart = performance.now();
    const server = await createServer({
      ...development.config.renderer,
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { ...development.config.renderer.server, middlewareMode: true, watch: null },
    });
    let coldTransformMs;
    const updates = [];
    try {
      const transformed = await server.transformRequest("/src/main.tsx");
      assert.equal(transformed.code.includes("desktop/src/renderer/src/main.tsx:"), enabled);
      coldTransformMs = performance.now() - devStart;
      for (let i = 0; i < 20; i++) {
        server.moduleGraph.invalidateModule(server.moduleGraph.getModuleById(resolve("src/renderer/src/main.tsx")));
        const updateStart = performance.now();
        await server.transformRequest("/src/main.tsx");
        updates.push(performance.now() - updateStart);
      }
    } finally {
      await server.close();
    }
    results.push({ enabled, buildMs, coldTransformMs, updateMs: updates.reduce((a, b) => a + b) / updates.length });
  }
  console.table(results);
} finally {
  await rm(directory, { recursive: true, force: true });
}
