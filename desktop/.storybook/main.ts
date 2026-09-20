import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";
import { defaultClientConditions } from "vite";

const config: StorybookConfig = {
  stories: ["../src/renderer/src/**/*.stories.tsx"],
  framework: "@storybook/react-vite",
  core: { disableTelemetry: true },
  async viteFinal(config) {
    config.resolve = {
      ...config.resolve,
      conditions: ["source", ...(config.resolve?.conditions ?? defaultClientConditions)],
    };
    config.server = { ...config.server, watch: { usePolling: true, interval: 100 } };
    config.esbuild = { ...config.esbuild, jsx: "automatic" };
    config.plugins = [...(config.plugins ?? []), tailwindcss()];
    return config;
  },
};
export default config;
