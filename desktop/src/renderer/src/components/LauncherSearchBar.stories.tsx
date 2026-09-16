import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { expect, fireEvent, fn, userEvent, within } from "storybook/test";
import { LauncherSearchBar } from "./LauncherSearchBar";

const meta = {
  title: "Launcher/SearchBar",
  component: LauncherSearchBar,
  args: { query: "", onQueryChange: fn(), onDismiss: fn() },
  render: function Interactive(args) {
    const [, updateArgs] = useArgs();
    return (
      <div style={{ width: 800, height: 71 }}>
        <LauncherSearchBar
          {...args}
          onQueryChange={(query) => {
            args.onQueryChange(query);
            updateArgs({ query });
          }}
        />
      </div>
    );
  },
} satisfies Meta<typeof LauncherSearchBar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const WithQuery: Story = { args: { query: "会议记录" } };
export const LongQuery: Story = {
  args: { query: "这是一段用于检查长文本显示的搜索内容 / Projects / XiaoWei / 会议记录与个人知识库归档" },
};
export const Dark: Story = { globals: { theme: "dark" } };
export const EscapeDismisses: Story = {
  args: { query: "待清空的内容" },
  play: async ({ canvasElement, args }) => {
    const input = within(canvasElement).getByRole("textbox", { name: "搜索" });
    await userEvent.click(input);
    await userEvent.keyboard("{Escape}");
    await expect(args.onDismiss).toHaveBeenCalledOnce();
    await expect(input).toHaveValue("");
  },
};

export const ComposingEscape: Story = {
  args: { query: "输入中的内容" },
  play: async ({ canvasElement, args }) => {
    const input = within(canvasElement).getByRole("textbox", { name: "搜索" });
    await fireEvent.compositionStart(input);
    await fireEvent.keyDown(input, { key: "Escape", isComposing: true, keyCode: 229 });
    await expect(args.onDismiss).not.toHaveBeenCalled();
    await expect(input).toHaveValue("输入中的内容");
    await fireEvent.compositionEnd(input);
  },
};

export const RefocusSelectsQuery: Story = {
  args: { query: "重新聚焦时选中" },
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole<HTMLInputElement>("textbox", { name: "搜索" });
    await userEvent.click(input);
    input.setSelectionRange(input.value.length, input.value.length);
    const previewWindow = canvasElement.ownerDocument.defaultView;
    if (!previewWindow) throw new Error("Missing preview window");
    await fireEvent.focus(previewWindow);
    await expect(input).toHaveFocus();
    await expect(input.selectionStart).toBe(0);
    await expect(input.selectionEnd).toBe(input.value.length);
  },
};
