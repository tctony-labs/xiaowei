import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/About",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  args: { initialTab: "about" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Release: Story = {};
export const Dark: Story = { globals: { theme: "dark" } };
export const Development: Story = { args: { development: true } };
export const WithoutVersion: Story = { args: { noVersion: true } };
export const CheckUpdate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "检查更新" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("检查更新（预览）");
  },
};
