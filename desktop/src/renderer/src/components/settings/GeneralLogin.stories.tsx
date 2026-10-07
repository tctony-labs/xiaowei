import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { GeneralLoginPreview } from "./GeneralLoginPreview";

const meta = {
  title: "Settings/GeneralLogin",
  component: GeneralLoginPreview,
  render: (args, context) => <GeneralLoginPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "settings", isRotated: false } },
} satisfies Meta<typeof GeneralLoginPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SignedOut: Story = {};
export const SignedIn: Story = { args: { signedIn: true } };
export const NoServers: Story = { args: { emptyServers: true } };
export const SavedServers: Story = {
  play: async () => {
    await userEvent.click(within(document.body).getByRole("button", { name: "登录服务器" }));
  },
};
export const AddServer: Story = { args: { initialDialog: "add" } };
export const Login: Story = { args: { initialDialog: "login" } };
export const LoginFailed: Story = { args: { initialDialog: "login", loginState: "error" } };
export const LoginPending: Story = {
  args: { initialDialog: "login", loginState: "pending" },
  play: async () => {
    const dialog = within(within(document.body).getByRole("dialog", { name: "登录" }));
    await userEvent.type(dialog.getByLabelText("邮箱"), "user@example.test");
    await userEvent.type(dialog.getByLabelText("密码"), "sample-password");
    await userEvent.click(dialog.getByRole("button", { name: "登录" }));
  },
};
export const LongAddress: Story = { args: { signedIn: true, longAddress: true } };
export const LongAddressPicker: Story = { args: { longAddress: true }, play: SavedServers.play };
export const LongAddressLogin: Story = { args: { longAddress: true, initialDialog: "login" } };
export const DarkLogin: Story = { args: { initialDialog: "login" }, globals: { theme: "dark" } };
