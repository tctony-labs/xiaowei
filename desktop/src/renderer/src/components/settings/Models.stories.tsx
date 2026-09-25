import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/Models",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  globals: { viewport: { value: "settings", isRotated: false } },
  args: { initialTab: "llm" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Configured: Story = {};
export const Unconfigured: Story = { args: { emptyModels: true } };
export const AddProvider: Story = { args: { initialModelDialog: "add" } };
export const EditProvider: Story = { args: { initialModelDialog: "edit" } };
export const EditCustomProvider: Story = { args: { initialModelDialog: "editCustom" } };
export const LocalPicker: Story = { args: { localEnabled: true, initialModelDialog: "local" } };
export const LocalDownloading: Story = { args: { localEnabled: true, localState: "downloading" } };
export const LocalFailed: Story = { args: { localEnabled: true, localState: "failed" } };
export const FetchingModels: Story = {
  args: { initialModelDialog: "editCustom", modelFetch: "loading" },
  play: openModelPicker,
};
export const FetchModelsFailed: Story = {
  args: { initialModelDialog: "editCustom", modelFetch: "error" },
  play: openModelPicker,
};
export const NoModelsReturned: Story = {
  args: { initialModelDialog: "editCustom", modelFetch: "empty" },
  play: openModelPicker,
};
export const ModelPicker: Story = { args: { initialModelDialog: "editCustom" }, play: openModelPicker };
export const ModelConfiguration: Story = {
  args: { initialModelDialog: "edit" },
  play: async () => {
    await userEvent.click(within(document.body).getByRole("button", { name: "编辑 deepseek-chat" }));
  },
};

export const AddModel: Story = {
  args: { initialModelDialog: "editCustom" },
  play: async () => {
    await userEvent.click(within(document.body).getByRole("button", { name: "+ 添加模型" }));
  },
};

async function openModelPicker() {
  await userEvent.click(within(document.body).getByRole("button", { name: "导入模型" }));
}

export const EnvironmentCredential: Story = {
  args: { initialModelDialog: "editCustom", providerWithoutKey: true },
  play: async () => {
    await userEvent.type(within(document.body).getByLabelText("API Key 环境变量名（优先使用）"), "CODEX_PROXY_API_KEY");
  },
};

export const DeepSeekResponses: Story = {
  args: { initialModelDialog: "add" },
  play: async () => {
    const page = within(document.body);
    await userEvent.click(page.getByRole("button", { name: "自定义" }));
    await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
    await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
    await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  },
};

export const ManyModels: Story = {
  args: { initialModelDialog: "editCustom", modelFetch: "many" },
  play: openModelPicker,
};
