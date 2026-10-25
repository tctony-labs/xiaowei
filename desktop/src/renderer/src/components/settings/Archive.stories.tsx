import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/Archive",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "settings", isRotated: false } },
  args: { initialTab: "archive" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const History: Story = {};
export const Empty: Story = { args: { archiveEmpty: true } };
export const DeleteConfirmation: Story = { args: { initialArchiveDelete: true } };
