import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/About",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "settings", isRotated: false } },
  args: { initialTab: "about" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Release: Story = {};
export const Development: Story = { args: { development: true } };
