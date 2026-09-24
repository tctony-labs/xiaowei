import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { QuickChatLauncherPreview } from "./QuickChatLauncherPreview";

const meta = {
  title: "Quick Chat/Launcher",
  component: QuickChatLauncherPreview,
  render: (args, context) => <QuickChatLauncherPreview key={context.id} {...args} />,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "快捷窗口交互预览。会话、回复和模型选择均为内存 mock；输入编辑器和消息渲染尚未完整迁移。",
      },
    },
    viewport: {
      options: {
        quickChat: {
          name: "Quick Chat (800 × 580)",
          styles: { width: "800px", height: "580px" },
          type: "desktop",
        },
      },
    },
  },
  globals: { viewport: { value: "quickChat", isRotated: false } },
} satisfies Meta<typeof QuickChatLauncherPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Search: Story = {};
export const FirstUse: Story = { args: { initialState: "first-use" } };
export const ExistingConversations: Story = { args: { initiallyExpanded: true } };
export const LastConversation: Story = { args: { initialState: "last-session", initiallyExpanded: true } };
export const AllArchived: Story = { args: { initialState: "all-archived", initiallyExpanded: true } };
export const AllDeleted: Story = { args: { initialState: "all-deleted", initiallyExpanded: true } };
export const SearchResults: Story = { args: { initialQuery: "搜索" } };
export const SessionMenu: Story = {
  args: { initiallyExpanded: true },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "选择会话" }));
  },
};
export const More: Story = {
  args: { initiallyExpanded: true },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: "更多操作" }));
  },
};
export const Rename: Story = {
  args: { initiallyExpanded: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "更多操作" }));
    await userEvent.click(canvas.getByRole("button", { name: "重命名" }));
  },
};
export const DeleteConfirmation: Story = {
  args: { initialState: "last-session", initiallyExpanded: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "更多操作" }));
    await userEvent.click(canvas.getByRole("button", { name: "删除会话" }));
  },
};
