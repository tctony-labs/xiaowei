import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["source", ...defaultClientConditions] },
  ssr: { resolve: { conditions: ["source", ...defaultServerConditions] } },
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    include: ["src/renderer/src/**/*.test.tsx", "src/renderer/src/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
