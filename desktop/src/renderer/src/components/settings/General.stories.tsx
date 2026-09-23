import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/General",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "settings", isRotated: false } },
  args: { initialTab: "general" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {};
export const SignedOut: Story = { args: { loggedIn: false } };
export const LoginFailed: Story = { args: { loggedIn: false, loginError: true, operationFailure: true } };
