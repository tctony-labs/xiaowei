import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test";
import type { LauncherApi } from "../../../shared/launcher-api";
import { Launcher } from "./Launcher";

const api: LauncherApi = {
  hide: fn(),
  resize: fn(),
  icon: fn(async () => null),
  execute: fn(async () => undefined),
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

export const OpenClipboard: Story = {
  args: {
    api: {
      ...api,
      search: fn(async (query: string) => ({
        token: 2,
        hits: query
          ? [
              {
                id: "command:clipboard",
                title: "剪贴板",
                provider: "command",
                label: "命令",
                score: 100,
                ranges: [],
              },
            ]
          : [],
      })),
      execute: fn(async () => "clipboard" as const),
    },
    clipboardApi: {
      resource: fn(async () => {}),
      openUrl: fn(async () => {}),
      categories: fn(async () => []),
      saveCategory: fn(async () => ({ id: "1", name: "分类", color: "#F5222D" })),
      deleteCategory: fn(async () => {}),
      setRemark: fn(async () => {}),
      setCategory: fn(async () => {}),
      editText: fn(async () => {
        throw new Error("Unused test API");
      }),
      list: fn(async () => []),
      get: fn(async () => null),
      readText: fn(async () => ""),
      readImage: fn(async () => new Uint8Array()),
      copy: fn(async () => {}),
      setFavorite: fn(async () => true),
      delete: fn(async () => true),
      clearHistory: fn(async () => 0),
      onChanged: () => () => {},
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("textbox", { name: "搜索" }), "clipboard");
    await canvas.findByRole("option", { name: "剪贴板 命令" });
    await userEvent.keyboard("{Enter}");
    await canvas.findByRole("navigation", { name: "剪贴板视图" });
    await expect(args.api?.resize).toHaveBeenLastCalledWith(0, "clipboard");
    await expect(args.api?.hide).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("textbox", { name: "搜索" }));
    await userEvent.keyboard("{Backspace}");
    await waitFor(() => expect(args.api?.resize).toHaveBeenLastCalledWith(0, undefined));
    await expect(canvas.queryByRole("navigation", { name: "剪贴板视图" })).toBeNull();
  },
};
