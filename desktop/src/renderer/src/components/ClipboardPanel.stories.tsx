import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import logo from "../../../../resources/logo-clear.png";
import type { ClipboardItem } from "../../../shared/clipboard-model";
import { ClipboardPanel } from "./ClipboardPanel";

const base = { createdAt: 1726502400000, lastUsedAt: 1726502400000, useCount: 2, favorite: false, paths: [] };
const items: ClipboardItem[] = [
  { ...base, id: "1", kind: "text", text: "XiaoWei 是一个效率工具。", favorite: true },
  { ...base, id: "2", kind: "text", previewTruncated: true, text: "一段很长的文本\n".repeat(60) },
  { ...base, id: "3", kind: "image", width: 512, height: 512 },
  { ...base, id: "4", kind: "file", paths: ["/Users/demo/Documents/设计草案.pdf", "/Users/demo/Documents/README.md"] },
];
const meta = {
  title: "Clipboard/Panel",
  component: ClipboardPanel,
  args: {
    onResource: fn(),
    onOpenUrl: fn(),
    categories: [],
    onReadText: fn(async () => "XiaoWei 是一个效率工具。"),
    onEditText: fn(async () => {}),
    onSetRemark: fn(async () => {}),
    onSetCategory: fn(async () => {}),
    onSaveCategory: fn(async () => {}),
    onDeleteCategory: fn(async () => {}),
    items,
    selectedId: "1",
    query: "",
    view: "all",
    onQueryChange: fn(),
    onViewChange: fn(),
    onActivate: fn(),
    onSelect: fn(),
    onCopy: fn(),
    onFavorite: fn(),
    onDelete: fn(),
    onBack: fn(),
  },
  render: function Preview(args) {
    const [, updateArgs] = useArgs();
    return (
      <div style={{ width: 800, height: 580 }}>
        <ClipboardPanel
          {...args}
          onSelect={(id) => {
            args.onSelect(id);
            updateArgs({ selectedId: id });
          }}
          onViewChange={(view) => {
            args.onViewChange(view);
            updateArgs({ view });
          }}
          onQueryChange={(query) => {
            args.onQueryChange(query);
            updateArgs({ query });
          }}
        />
      </div>
    );
  },
} satisfies Meta<typeof ClipboardPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const History: Story = {};
export const Dark: Story = { globals: { theme: "dark" } };
export const Empty: Story = { args: { items: [], selectedId: undefined } };
export const Favorites: Story = { args: { view: "favorites", items: [items[0]] } };
export const LongText: Story = { args: { selectedId: "2", previewText: "长文本预览，保留原始换行。\n".repeat(100) } };
export const Image: Story = { args: { selectedId: "3", previewImage: logo, thumbnails: { "3": logo } } };
export const Files: Story = { args: { selectedId: "4" } };
export const Loading: Story = { args: { items: [], loading: true, selectedId: undefined } };
export const LoadError: Story = { args: { error: "读取剪贴板失败，请重新进入重试", items: [] } };
export const NoMatches: Story = { args: { items: [], query: "不存在的内容" } };
export const KeyboardAndActions: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox", { name: "搜索" });
    await userEvent.click(input);
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(canvas.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true"));
    await userEvent.keyboard("{Enter}");
    await expect(args.onActivate).toHaveBeenCalledWith("2");
    await userEvent.click(
      within(canvas.getByRole("region", { name: "内容预览" })).getByRole("button", { name: "收藏" }),
    );
    await expect(args.onFavorite).toHaveBeenCalledWith("2", true);
    await userEvent.click(canvas.getByRole("button", { name: "删除" }));
    await expect(args.onDelete).not.toHaveBeenCalled();
    const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog", { name: "确认删除" });
    await userEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await expect(args.onDelete).toHaveBeenCalledWith("2");
    await userEvent.click(input);
    await userEvent.keyboard("{Escape}");
    await expect(args.onBack).toHaveBeenCalled();
  },
};

export const CategoriesAndContextMenu: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox", { name: "搜索" });
    await userEvent.click(input);
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(canvas.getByRole("button", { name: "图片" })).toHaveAttribute("aria-pressed", "true"));
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(canvas.getByRole("button", { name: "剪贴板" })).toHaveAttribute("aria-pressed", "true"));
    const row = canvas.getAllByRole("option")[0];
    await userEvent.pointer({ target: row, keys: "[MouseRight]" });
    await userEvent.click(canvas.getByRole("menuitem", { name: "复制" }));
    await expect(args.onCopy).toHaveBeenCalledWith("1");
    await expect(args.onActivate).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "展开" }));
    await expect(canvas.getByText("使用次数")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "收起" }));
    await expect(canvas.queryByText("使用次数")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "删除" }));
    await userEvent.keyboard("{Escape}");
    await expect(args.onDelete).not.toHaveBeenCalled();
    await expect(args.onBack).not.toHaveBeenCalled();
    await userEvent.click(input);
    await userEvent.keyboard("{Backspace}");
    await expect(args.onBack).toHaveBeenCalledOnce();
  },
};

export const Json: Story = { args: { items: [{ ...items[0], text: '{"name":"XiaoWei","local":true}' }] } };

export const EditingAndCategories: Story = {
  args: { categories: [{ id: "10", name: "工作", color: "#F5222D" }] },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("button", { name: "编辑" }));
    let dialog = within(await screen.findByRole("dialog", { name: "编辑文本" }));
    const text = dialog.getByRole("textbox", { name: "编辑文本" });
    await waitFor(() => expect(text).toHaveValue("XiaoWei 是一个效率工具。"));
    await userEvent.clear(text);
    await userEvent.type(text, "修改后的文本");
    await userEvent.click(dialog.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(args.onEditText).toHaveBeenCalledWith("1", "修改后的文本"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(canvas.getByRole("button", { name: "备注" }));
    dialog = within(screen.getByRole("dialog", { name: "编辑备注" }));
    await userEvent.type(dialog.getByRole("textbox"), "项目资料");
    await userEvent.click(dialog.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(args.onSetRemark).toHaveBeenCalledWith("1", "项目资料"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(canvas.getByRole("button", { name: "分类" }));
    dialog = within(screen.getByRole("dialog", { name: "设置分类" }));
    await userEvent.click(dialog.getByRole("button", { name: "工作" }));
    await waitFor(() => expect(args.onSetCategory).toHaveBeenCalledWith("1", "10"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(canvas.getByRole("button", { name: "新建分类" }));
    dialog = within(screen.getByRole("dialog", { name: "新建分类" }));
    await userEvent.type(dialog.getByRole("textbox", { name: "分类名称" }), "资料");
    await userEvent.click(dialog.getByRole("button", { name: "颜色 #1677FF" }));
    await userEvent.click(dialog.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(args.onSaveCategory).toHaveBeenCalledWith("资料", "#1677FF", undefined));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.pointer({ target: canvas.getByRole("button", { name: "工作" }), keys: "[MouseRight]" });
    await userEvent.click(canvas.getByRole("menuitem", { name: "编辑" }));
    dialog = within(screen.getByRole("dialog", { name: "编辑分类" }));
    await userEvent.clear(dialog.getByRole("textbox"));
    await userEvent.type(dialog.getByRole("textbox"), "工作归档");
    await userEvent.click(dialog.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(args.onSaveCategory).toHaveBeenCalledWith("工作归档", "#F5222D", "10"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.pointer({ target: canvas.getByRole("button", { name: "工作" }), keys: "[MouseRight]" });
    await userEvent.click(canvas.getByRole("menuitem", { name: "删除" }));
    dialog = within(screen.getByRole("dialog", { name: "确认删除" }));
    await expect(args.onDeleteCategory).not.toHaveBeenCalled();
    await userEvent.click(dialog.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(args.onDeleteCategory).toHaveBeenCalledWith("10"));
  },
};

export const ResourceMenus: Story = {
  args: { selectedId: "4" },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "设计草案.pdf" }));
    await userEvent.click(canvas.getByRole("menuitem", { name: "复制路径" }));
    await expect(args.onResource).toHaveBeenCalledWith("4", "copyPath", 0);
    await userEvent.click(canvas.getByRole("button", { name: "README.md" }));
    await userEvent.click(canvas.getByRole("menuitem", { name: "打开" }));
    await expect(args.onResource).toHaveBeenCalledWith("4", "open", 1);
    await userEvent.pointer({ target: canvas.getByRole("option", { name: "图片" }), keys: "[MouseRight]" });
    await userEvent.click(canvas.getByRole("menuitem", { name: "在文件夹中查看" }));
    await expect(args.onResource).toHaveBeenCalledWith("3", "reveal");
    await userEvent.pointer({ target: canvas.getByRole("option", { name: "图片" }), keys: "[MouseRight]" });
    await userEvent.hover(canvas.getByRole("menuitem", { name: "复制" }));
    await userEvent.click(await canvas.findByRole("menuitem", { name: "图片路径" }));
    await expect(args.onResource).toHaveBeenCalledWith("3", "copyPath");
    await userEvent.click(canvas.getAllByRole("option")[1]);
    await userEvent.click(await canvas.findByRole("button", { name: "查看全部文本" }));
    await expect(args.onResource).toHaveBeenCalledWith("2", "open");
  },
};

export const MarkdownWebContent: Story = {
  args: {
    items: [
      {
        ...items[0],
        text: "[项目主页](https://example.com/xiaowei)\n\n![远程图片](https://example.com/clipboard-preview.png)",
      },
    ],
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "查看MARKDOWN" }));
    await userEvent.click(await canvas.findByRole("link", { name: "项目主页" }));
    await expect(args.onOpenUrl).toHaveBeenCalledWith("https://example.com/xiaowei");
    await expect(canvas.getByRole("img", { name: "远程图片" })).toHaveAttribute(
      "src",
      "https://example.com/clipboard-preview.png",
    );
  },
};

export const SelectionScrollPadding: Story = {
  args: {
    items: Array.from({ length: 30 }, (_, index) => ({
      ...base,
      id: String(index + 1),
      kind: "text",
      text: `滚动记录 ${index + 1}`,
    })),
    selectedId: "1",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole("listbox", { name: "剪贴板记录" });
    const input = canvas.getByRole("textbox");
    await userEvent.click(input);
    const checkSelection = async (index: number) => {
      await waitFor(() => {
        const row = within(list).getAllByRole("option")[index];
        expect(row).toHaveAttribute("aria-selected", "true");
        const bounds = list.getBoundingClientRect();
        const item = row.getBoundingClientRect();
        expect(item.top).toBeGreaterThanOrEqual(bounds.top + 7);
        expect(item.bottom).toBeLessThanOrEqual(bounds.bottom - 7);
      });
    };
    await checkSelection(0);
    for (let index = 1; index < 30; index++) {
      await userEvent.keyboard("{ArrowDown}");
      await checkSelection(index);
    }
    for (let index = 28; index >= 0; index--) {
      await userEvent.keyboard("{ArrowUp}");
      await checkSelection(index);
    }
  },
};
