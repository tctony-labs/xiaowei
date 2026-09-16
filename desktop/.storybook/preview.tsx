import type { Preview } from "@storybook/react-vite";
import { useEffect } from "react";
import "../src/renderer/src/style.css";
import "./preview.css";

const preview: Preview = {
  parameters: { layout: "centered" },
  globalTypes: {
    theme: {
      description: "主题",
      toolbar: {
        icon: "circlehollow",
        items: [
          { value: "light", title: "浅色" },
          { value: "dark", title: "深色" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  decorators: [
    function Theme(Story, context) {
      useEffect(() => {
        document.documentElement.dataset.theme = context.globals.theme;
      }, [context.globals.theme]);
      return <Story />;
    },
  ],
};
export default preview;
