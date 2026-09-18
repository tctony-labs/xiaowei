import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/Window",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  args: { initialTab: "general" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Dark: Story = { globals: { theme: "dark" } };
export const Loading: Story = { args: { loading: true } };
export const Navigate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ["快捷键", "剪贴板", "模型", "智能体", "对话归档", "关于", "通用"]) {
      await userEvent.click(canvas.getByRole("button", { name }));
      await expect(canvas.getByRole("heading", { name })).toBeVisible();
    }
    await expect(canvas.queryByRole("button", { name: "扩展" })).not.toBeInTheDocument();
  },
};
