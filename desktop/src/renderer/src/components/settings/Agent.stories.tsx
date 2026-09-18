import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/Agent",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  args: { initialTab: "agent" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Dark: Story = { globals: { theme: "dark" } };
export const Configured: Story = { args: { searchConfigured: true } };
export const ConfigureKey: Story = { args: { initialSearchEditor: "tavily" } };
export const EditKey: Story = { args: { searchConfigured: true, initialSearchEditor: "tavily" } };
export const Highlighted: Story = { args: { highlighted: true } };
export const TestFailure: Story = {
  args: { operationFailure: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "测试" }));
    await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("操作失败"));
  },
};
export const KeyFailure: Story = {
  args: { initialSearchEditor: "tavily", operationFailure: true },
  play: async () => {
    const page = within(document.body);
    fireEvent.change(page.getByLabelText("API Key"), { target: { value: "storybook-placeholder" } });
    await waitFor(() => expect(page.getByLabelText("API Key")).toHaveValue("storybook-placeholder"));
    await waitFor(() => expect(page.getByRole("button", { name: "保存" })).toBeEnabled());
    await userEvent.click(page.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(page.getByRole("alert")).toHaveTextContent("操作失败"));
  },
};
export const DeleteKey: Story = {
  args: { searchConfigured: true, initialSearchEditor: "tavily" },
  play: async () => {
    const page = within(document.body);
    await userEvent.click(page.getByRole("button", { name: "删除 Key" }));
    await expect(page.getByRole("dialog", { name: "删除 API Key" })).toHaveTextContent("自动切回 Bing");
  },
};
export const DeleteAndFallback: Story = {
  args: { searchConfigured: true, initialSearchEditor: "tavily" },
  play: async () => {
    const page = within(document.body);
    await userEvent.click(page.getByRole("button", { name: "删除 Key" }));
    await userEvent.click(page.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
    await expect(page.getByRole("button", { name: "Bing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "配置 Tavily" })).toBeVisible();
  },
};
