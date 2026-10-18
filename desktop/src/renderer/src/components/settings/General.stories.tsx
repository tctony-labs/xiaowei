import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { GeneralLoginPreview } from "./GeneralLoginPreview";

const meta = {
  title: "Settings/General",
  component: GeneralLoginPreview,
  render: (args, context) => <GeneralLoginPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "settings", isRotated: false } },
} satisfies Meta<typeof GeneralLoginPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedOut: Story = {};
export const SignedIn: Story = { args: { signedIn: true } };
export const Connecting: Story = {
  args: { signedIn: true, connectionStatus: "connecting" },
};
export const Disconnected: Story = {
  args: { signedIn: true, connectionStatus: "disconnected" },
};
export const LongAddress: Story = { args: { signedIn: true, longAddress: true } };
export const ManageSingleSession: Story = {
  args: { signedIn: true, initialDialog: "manage" },
};
export const ManageServers: Story = {
  args: { signedIn: true, multipleSessions: true, initialDialog: "manage" },
};
export const ManageLongAddress: Story = {
  args: { signedIn: true, multipleSessions: true, longAddress: true, initialDialog: "manage" },
};
export const ManageAddServer: Story = {
  args: { signedIn: true, initialDialog: "manage" },
  play: async () => {
    const dialog = within(within(document.body).getByRole("dialog", { name: "账号管理" }));
    await userEvent.click(dialog.getByRole("button", { name: "+ 添加新服务器" }));
  },
};
export const ManageAddChecking: Story = {
  args: { signedIn: true, initialDialog: "manage", addState: "pending" },
  play: async ({ userEvent }) => {
    const dialog = within(within(document.body).getByRole("dialog", { name: "账号管理" }));
    await userEvent.click(dialog.getByRole("button", { name: "+ 添加新服务器" }));
    await userEvent.type(dialog.getByLabelText("服务器地址"), "https://new.example.test");
    await userEvent.click(dialog.getByRole("button", { name: "添加" }));
  },
};
export const AddServer: Story = { args: { initialDialog: "add" } };
export const AddServerChecking: Story = {
  args: { initialDialog: "add", addState: "pending" },
  play: async ({ userEvent }) => {
    const dialog = within(within(document.body).getByRole("dialog", { name: "添加服务器" }));
    await userEvent.type(dialog.getByLabelText("服务器地址"), "https://new.example.test");
    await userEvent.click(dialog.getByRole("button", { name: "保存" }));
  },
};
export const Login: Story = { args: { initialDialog: "login" } };
export const LoginFailed: Story = {
  args: { initialDialog: "login", loginState: "error" },
};
export const LoginPending: Story = {
  args: { initialDialog: "login", loginState: "pending" },
  play: async () => {
    const dialog = within(within(document.body).getByRole("dialog", { name: "登录" }));
    await userEvent.type(dialog.getByLabelText("邮箱"), "user@example.test");
    await userEvent.type(dialog.getByLabelText("密码"), "sample-password");
    await userEvent.click(dialog.getByRole("button", { name: "登录" }));
  },
};
