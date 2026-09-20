import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        include: ["xiaowei-search", "xiaowei-clipboard"],
        exclude: ["xiaowei-gateway", "xiaowei-contracts", "@bufbuild/protobuf"],
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ["xiaowei-gateway", "xiaowei-contracts", "@bufbuild/protobuf"] },
      rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } },
    },
  },
  renderer: {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "development-csp",
        apply: "serve",
        transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
      },
    ],
    server: { host: "127.0.0.1", watch: { usePolling: true, interval: 100 } },
  },
});
