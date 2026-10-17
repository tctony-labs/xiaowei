import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { sourceLocationPlugin } from "@xiaowei/source-log/vite";
import { defineConfig } from "electron-vite";
import { defaultClientConditions, defaultServerConditions } from "vite";

export default defineConfig(({ command }) => ({
  main: {
    resolve: { conditions: ["source", ...defaultServerConditions] },
    ssr: { resolve: { conditions: ["source", ...defaultServerConditions] } },
    plugins: [sourceLocationPlugin()],
    build: {
      sourcemap: false,
      minify: command === "build" ? "esbuild" : false,
      externalizeDeps: false,
      rollupOptions: {
        external: [
          "xiaowei-agent",
          "xiaowei-search",
          "xiaowei-clipboard",
          "xiaowei-storage",
          "xiaowei-platform",
        ],
        input: {
          index: fileURLToPath(new URL("./src/main/index.ts", import.meta.url)),
          "llm-worker": fileURLToPath(
            new URL("./src/main/services/llm/worker/index.ts", import.meta.url),
          ),
        },
        output: { format: "es", entryFileNames: "[name].js" },
      },
    },
  },
  preload: {
    resolve: { conditions: ["source", ...defaultServerConditions] },
    ssr: { resolve: { conditions: ["source", ...defaultServerConditions] } },
    plugins: [sourceLocationPlugin()],
    build: {
      sourcemap: false,
      minify: command === "build" ? "esbuild" : false,
      externalizeDeps: false,
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } },
    },
  },
  renderer: {
    build: { sourcemap: false },
    resolve: { conditions: ["source", ...defaultClientConditions] },
    plugins: [
      sourceLocationPlugin(),
      react(),
      tailwindcss(),
      {
        name: "development-csp",
        apply: "serve",
        transformIndexHtml: (html) =>
          html.replace(
            "script-src 'self'",
            "script-src 'self' 'unsafe-inline'; worker-src 'self' blob:",
          ),
      },
    ],
    server: { host: "127.0.0.1", watch: { usePolling: true, interval: 100 } },
  },
}));
