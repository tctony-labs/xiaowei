import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/Models",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  args: { initialTab: "llm" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Configured: Story = {};
export const Dark: Story = { globals: { theme: "dark" }, args: { localEnabled: true } };
export const Unconfigured: Story = { args: { emptyModels: true } };
export const ProviderWithoutKey: Story = { args: { providerWithoutKey: true } };
export const AddProvider: Story = { args: { initialModelDialog: "add" } };
export const EditProvider: Story = { args: { initialModelDialog: "edit" } };
export const SwitchProvider: Story = { args: { initialModelDialog: "switch" } };
export const ImageTesting: Story = { args: { imageTesting: true } };
export const LocalReady: Story = { args: { localEnabled: true } };
export const LocalMissing: Story = { args: { localEnabled: true, localState: "missing" } };
export const LocalDownloading: Story = { args: { localEnabled: true, localState: "downloading" } };
export const LocalVerifying: Story = { args: { localEnabled: true, localState: "verifying" } };
export const LocalUnzipping: Story = { args: { localEnabled: true, localState: "unzipping" } };
export const LocalFailed: Story = { args: { localEnabled: true, localState: "failed" } };
export const LocalPicker: Story = { args: { localEnabled: true, initialModelDialog: "local" } };
export const LocalPickerDark: Story = {
  globals: { theme: "dark" },
  args: { localEnabled: true, initialModelDialog: "local" },
};
export const Highlighted: Story = { args: { highlighted: true, localEnabled: true } };
export const SaveFailure: Story = {
  args: { initialModelDialog: "edit", operationFailure: true },
  play: async () => {
    const page = within(document.body);
    await userEvent.click(page.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(page.getByRole("alert")).toHaveTextContent("操作失败"));
    await expect(page.getByRole("dialog", { name: "修改模型提供商" })).toBeVisible();
  },
};
export const ProviderInteractions: Story = {
  args: { initialModelDialog: "edit" },
  play: async () => {
    const page = within(document.body);
    await userEvent.click(page.getByRole("button", { name: "上下文窗口" }));
    await expect(page.getAllByRole("button", { name: "默认" })[0]).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "OpenAI Chat" }));
    await userEvent.click(page.getByRole("button", { name: "OpenAI Responses" }));
    await expect(page.getByText("Transport", { exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "删除" }));
    await expect(page.getByRole("button", { name: "确认删除" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "取消" }));
    await expect(page.queryByRole("dialog")).not.toBeInTheDocument();
  },
};
export const AddAndSwitch: Story = {
  args: { initialModelDialog: "add" },
  play: async () => {
    const page = within(document.body);
    fireEvent.change(page.getByLabelText("名称"), { target: { value: "example" } });
    fireEvent.change(page.getByLabelText("Base URL"), { target: { value: "https://models.example.test/v1" } });
    fireEvent.change(page.getByLabelText("API Key"), { target: { value: "storybook-placeholder" } });
    await waitFor(() => expect(page.getByLabelText("API Key")).toHaveValue("storybook-placeholder"));
    await waitFor(() => expect(page.getByRole("button", { name: "保存" })).toBeEnabled());
    await userEvent.click(page.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(page.getByRole("dialog", { name: "切换模型提供商" })).toBeVisible(), { timeout: 3000 });
    await userEvent.click(page.getByRole("button", { name: "切换" }));
    await expect(page.queryByRole("dialog")).not.toBeInTheDocument();
    await expect(page.getByRole("button", { name: "example / demo-text" })).toBeVisible();
  },
};
export const ResponsesProtocol: Story = {
  args: { initialModelDialog: "edit" },
  play: async () => {
    const page = within(document.body);
    await userEvent.click(page.getByRole("button", { name: "OpenAI Chat" }));
    await userEvent.click(page.getByRole("button", { name: "OpenAI Responses" }));
    await expect(page.getByText("Transport", { exact: true })).toBeVisible();
  },
};
export const ContextOverrides: Story = {
  args: { initialModelDialog: "edit" },
  play: async () => {
    const page = within(document.body);
    await userEvent.click(page.getByRole("button", { name: "上下文窗口" }));
    await expect(page.getAllByRole("button", { name: "默认" })).toHaveLength(2);
  },
};
export const DeleteProviderConfirmation: Story = {
  args: { initialModelDialog: "edit" },
  play: async () => {
    const page = within(document.body);
    await userEvent.click(page.getByRole("button", { name: "删除" }));
    await expect(page.getByRole("button", { name: "确认删除" })).toBeVisible();
  },
};
export const LocalPickerDownloading: Story = {
  args: { localEnabled: true, initialModelDialog: "local", localState: "downloading" },
};
export const LocalPickerFailed: Story = {
  args: { localEnabled: true, initialModelDialog: "local", localState: "failed" },
};
export const ImageValidationFailure: Story = {
  args: { operationFailure: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "未设置" }));
    await userEvent.click(within(document.body).getByRole("button", { name: "demo / demo-image" }));
    await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("该模型不支持图片生成"));
  },
};
