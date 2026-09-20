import { create } from "@bufbuild/protobuf";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, fn, userEvent, waitFor, within } from "storybook/test";
import {
  Clipboard,
  ClipboardCategoriesSchema,
  ClipboardChangedSchema,
  ClipboardItemsSchema,
  EmptySchema,
  ExecuteResponseSchema,
  LauncherMode,
  LauncherOpenedSchema,
  LauncherSearchResponseSchema,
  Launcher as LauncherService,
} from "xiaowei-contracts";
import { bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../services";
import { Launcher } from "./Launcher";

function preview(clipboardMode = false) {
  const host = new GatewayHost();
  const calls = { execute: fn(), resize: fn(), hide: fn() };
  host.registerOwner(
    "launcher",
    bindHandlers(LauncherService, {
      query: ({ query: value }) =>
        create(LauncherSearchResponseSchema, {
          token: clipboardMode ? 2 : 1,
          hits: !value
            ? []
            : clipboardMode
              ? [{ id: "command:clipboard", title: "剪贴板", provider: "command", label: "命令" }]
              : [
                  { id: "one", title: "微信", provider: "app", label: "应用", score: 100 },
                  { id: "two", title: "微信文档", provider: "bookmark", label: "网页", score: 90 },
                ],
        }),
      execute(request) {
        calls.execute(request);
        return create(ExecuteResponseSchema, { mode: clipboardMode ? LauncherMode.CLIPBOARD : undefined });
      },
      updateLayout(request) {
        calls.resize(request);
        return create(EmptySchema);
      },
      hide() {
        calls.hide();
        return create(EmptySchema);
      },
      resetPosition: () => create(EmptySchema),
    }),
    [{ name: LauncherOpenedSchema.typeName, policy: "coalesce", validate() {}, matches: () => true }],
  );

  let subscribed = false;

  const unused = () => {
    throw new Error("Unused preview route");
  };
  host.registerOwner(
    "clipboard",
    bindHandlers(Clipboard, {
      list: () => create(ClipboardItemsSchema),
      categories: () => {
        if (!subscribed) throw new Error("Snapshot requested before subscription ready");
        return create(ClipboardCategoriesSchema);
      },
      get: unused,
      readText: unused,
      readImage: unused,
      copy: unused,
      delete: unused,
      setFavorite: unused,
      clearHistory: unused,
      saveCategory: unused,
      deleteCategory: unused,
      setRemark: unused,
      editText: unused,
      setCategory: unused,
      openResource: unused,
      revealResource: unused,
      copyResourcePath: unused,
    }),
    [
      {
        name: ClipboardChangedSchema.typeName,
        policy: "coalesce",
        async attach() {
          await new Promise((resolve) => setTimeout(resolve, 50));
          subscribed = true;
          return { close() {} };
        },
      },
    ],
  );

  return { calls, services: createServices(() => host.client({ caller: "storybook", trusted: true })) };
}

const search = preview();
const clipboard = preview(true);
const meta = {
  title: "Launcher/Interaction",
  component: Launcher,
  args: { services: search.services },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Launcher>;
export default meta;
type Story = StoryObj<typeof meta>;

export const KeyboardAndComposition: Story = {
  play: async ({ canvasElement }) => {
    search.calls.execute.mockClear();
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox", { name: "搜索" });
    await userEvent.type(input, "wx");
    const second = await canvas.findByRole("option", { name: "微信文档 网页" });
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(second).toHaveAttribute("aria-selected", "true"));
    await userEvent.keyboard("{ArrowDown}");
    await expect(second).toHaveAttribute("aria-selected", "true");
    await fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    await expect(search.calls.execute).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    await expect(search.calls.execute).toHaveBeenCalledWith(expect.objectContaining({ token: 1, id: "two" }));
    await waitFor(() => expect(input).toHaveValue(""));
  },
};

export const OpenClipboard: Story = {
  args: { services: clipboard.services },
  play: async ({ canvasElement }) => {
    clipboard.calls.hide.mockClear();
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("textbox", { name: "搜索" }), "clipboard");
    await canvas.findByRole("option", { name: "剪贴板 命令" });
    await userEvent.keyboard("{Enter}");
    await canvas.findByRole("navigation", { name: "剪贴板视图" });
    await waitFor(() =>
      expect(clipboard.calls.resize).toHaveBeenLastCalledWith(
        expect.objectContaining({ resultCount: 0, mode: LauncherMode.CLIPBOARD }),
      ),
    );
    await expect(clipboard.calls.hide).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("textbox", { name: "搜索" }));
    await userEvent.keyboard("{Backspace}");
    await waitFor(() =>
      expect(clipboard.calls.resize).toHaveBeenLastCalledWith(
        expect.objectContaining({ resultCount: 0, mode: LauncherMode.SEARCH }),
      ),
    );
    await expect(canvas.queryByRole("navigation", { name: "剪贴板视图" })).toBeNull();
  },
};
