import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/Clipboard",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "settings", isRotated: false } },
  args: { initialTab: "clipboard" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Cleaning: Story = { args: { cleanup: "cleaning" } };
export const CleanupFailed: Story = { args: { cleanup: "error", operationFailure: true } };
