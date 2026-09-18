import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/Archive",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  args: { initialTab: "archive" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const History: Story = {};
export const Dark: Story = { globals: { theme: "dark" } };
export const Empty: Story = { args: { archiveEmpty: true } };
export const Loading: Story = { args: { archiveLoading: true, archiveEmpty: true } };
export const NoMatches: Story = { args: { archiveNoMatches: true } };
export const LongList: Story = { args: { archiveLong: true } };
export const DeleteConfirmation: Story = { args: { initialArchiveDelete: true } };
export const SearchAndDelete: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    fireEvent.change(canvas.getByPlaceholderText("搜索标题或工作区"), { target: { value: "XiaoWei" } });
    await expect(canvas.getByText("搜索与剪贴板交互讨论")).toBeVisible();
    await waitFor(() => expect(canvas.queryByText("整理本周的开发事项")).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole("button", { name: "删除" }));
    await userEvent.click(page.getByRole("button", { name: "取消" }));
    await expect(canvas.getByText("搜索与剪贴板交互讨论")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "删除" }));
    await userEvent.click(within(page.getByRole("dialog")).getByRole("button", { name: "删除" }));
    await expect(canvas.getByText("未找到匹配的会话")).toBeVisible();
  },
};
