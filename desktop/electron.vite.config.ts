import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { sourceLocationPlugin } from "@xiaowei/source-log/vite";
import { defineConfig } from "electron-vite";
import { defaultClientConditions, defaultServerConditions } from "vite";

export default defineConfig({
  main: {
    resolve: { conditions: ["source", ...defaultServerConditions] },
    ssr: { resolve: { conditions: ["source", ...defaultServerConditions] } },
    plugins: [sourceLocationPlugin()],
    build: {
      externalizeDeps: {
        include: ["xiaowei-search", "xiaowei-clipboard", "xiaowei-storage"],
        exclude: ["xiaowei-gateway", "xiaowei-contracts", "@bufbuild/protobuf"],
      },
    },
  },
  preload: {
    resolve: { conditions: ["source", ...defaultServerConditions] },
    ssr: { resolve: { conditions: ["source", ...defaultServerConditions] } },
    plugins: [sourceLocationPlugin()],
    build: {
      externalizeDeps: { exclude: ["xiaowei-gateway", "xiaowei-contracts", "@bufbuild/protobuf"] },
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } },
    },
  },
  renderer: {
    resolve: { conditions: ["source", ...defaultClientConditions] },
    plugins: [
      sourceLocationPlugin(),
      react(),
      tailwindcss(),
      {
        name: "development-csp",
        apply: "serve",
        transformIndexHtml: (html) =>
          html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'; worker-src 'self' blob:"),
      },
    ],
    server: { host: "127.0.0.1", watch: { usePolling: true, interval: 100 } },
  },
});
