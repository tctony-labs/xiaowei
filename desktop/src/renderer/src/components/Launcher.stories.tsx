import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test";
import type { LauncherApi } from "../../../shared/launcher-api";
import { Launcher } from "./Launcher";

const api: LauncherApi = {
  hide: fn(),
  resize: fn(),
  icon: fn(async () => null),
  execute: fn(async () => {}),
  search: fn(async (query: string) => ({
    token: 1,
    hits: query
      ? [
          { id: "one", title: "微信", provider: "app", label: "应用", score: 100, ranges: [] },
          { id: "two", title: "微信文档", provider: "bookmark", label: "网页", score: 90, ranges: [] },
        ]
      : [],
  })),
};
const meta = {
  title: "Launcher/Interaction",
  component: Launcher,
  args: { api },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Launcher>;
export default meta;
type Story = StoryObj<typeof meta>;

export const KeyboardAndComposition: Story = {
  play: async ({ canvasElement, args }) => {
    if (!args.api) throw new Error("Missing preview API");
    const previewApi = args.api;
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox", { name: "搜索" });
    await userEvent.type(input, "wx");
    const second = await canvas.findByRole("option", { name: "微信文档 网页" });
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => {
      if (second.getAttribute("aria-selected") !== "true") throw new Error("Selection pending");
    });
    await userEvent.keyboard("{ArrowDown}");
    await expect(second).toHaveAttribute("aria-selected", "true");
    await fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    await expect(previewApi.execute).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    await expect(previewApi.execute).toHaveBeenCalledWith(1, "two");
    await waitFor(() => {
      if ((input as HTMLInputElement).value !== "") throw new Error("Clear pending");
    });
    await expect(input).toHaveValue("");
  },
};
