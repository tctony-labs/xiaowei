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
    await userEvent.click(within(document.body).getByRole("button", { name: "配置 deepseek-chat" }));
  },
};

async function openModelPicker() {
  await userEvent.click(within(document.body).getByRole("button", { name: "获取可用模型" }));
}
