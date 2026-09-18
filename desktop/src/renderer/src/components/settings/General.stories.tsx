import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/General",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  args: { initialTab: "general" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {};
export const Dark: Story = { globals: { theme: "dark" } };
export const SignedOut: Story = { args: { loggedIn: false } };
export const WaitingForScan: Story = { args: { loggedIn: false, loginWaiting: true } };
export const LoginFailed: Story = { args: { loggedIn: false, loginError: true, operationFailure: true } };
export const Disconnected: Story = { args: { accountStatus: "disconnected" } };
export const Connecting: Story = { args: { accountStatus: "connecting" } };
export const CredentialRejected: Story = { args: { accountStatus: "credential_rejected" } };
export const LongNickname: Story = { args: { longText: true } };
export const AccountAndControls: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole("switch", { name: "开机自启动" });
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(canvas.getByRole("button", { name: "退出登录" }));
    await expect(canvas.getByText("未登录")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "退出登录" })).toBeVisible());
  },
};
