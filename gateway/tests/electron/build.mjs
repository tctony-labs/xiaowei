// Bundles test assets only. Never launches an Electron instance.
import { mkdtemp } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, defaultClientConditions } from "vite";

const directory = await mkdtemp(join(tmpdir(), "xiaowei-gateway-acceptance-"));
await build({
  configFile: false,
  resolve: { conditions: ["source", "node"] },
  // Keep native package resolution and fixture paths anchored to this checkout.
  define: { "import.meta.url": JSON.stringify(new URL("run.mjs", import.meta.url).href) },
  logLevel: "warn",
  build: {
    target: "node22",
    outDir: directory,
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL("run.mjs", import.meta.url)),
      formats: ["es"],
      fileName: () => "main.mjs",
    },
    rollupOptions: { external: (id) => isBuiltin(id) || id === "electron" },
  },
});

for (const target of ["preload", "renderer"]) {
  await build({
    configFile: false,
    resolve: { conditions: ["source", ...defaultClientConditions] },
    logLevel: "warn",
    build: {
      outDir: directory,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL(`${target}.ts`, import.meta.url)),
        formats: [target === "preload" ? "cjs" : "es"],
        fileName: () => `${target}.${target === "preload" ? "cjs" : "js"}`,
      },
      rollupOptions: { external: target === "preload" ? ["electron"] : [] },
    },
  });
}
console.log(directory);
