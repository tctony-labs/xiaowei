import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/Window",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "settings", isRotated: false } },
  args: { initialTab: "general" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Loading: Story = { args: { loading: true } };
export const PhaseOneScope: Story = { args: { phaseOne: true } };
