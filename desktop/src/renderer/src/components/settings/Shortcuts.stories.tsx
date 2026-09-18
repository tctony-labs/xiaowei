import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/Shortcuts",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  args: { initialTab: "shortcut" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Configured: Story = {};
export const Dark: Story = { globals: { theme: "dark" } };
export const Empty: Story = { args: { noShortcuts: true } };
export const Recording: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("textbox", { name: "录制全局搜索快捷键" }));
  },
};
export const DuplicateAndCancel: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = canvas.getByRole("textbox", { name: "录制全局搜索快捷键" });
    const clipboard = canvas.getByRole("textbox", { name: "录制剪贴板快捷键" });
    await userEvent.click(clipboard);
    await userEvent.keyboard("{Meta>}[Space]{/Meta}{Enter}");
    await expect(search).toHaveTextContent("录制全局搜索快捷键");
    await expect(clipboard).toHaveTextContent("Space");
    await userEvent.click(clipboard);
    await userEvent.keyboard("{Escape}");
    await expect(clipboard).toHaveTextContent("Space");
  },
};
