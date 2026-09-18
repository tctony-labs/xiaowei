import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { SettingsPreview } from "./SettingsPreview";

const meta = {
  title: "Settings/Clipboard",
  component: SettingsPreview,
  render: (args, context) => <SettingsPreview key={context.id} {...args} />,
  parameters: { layout: "fullscreen" },
  args: { initialTab: "clipboard" },
} satisfies Meta<typeof SettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Dark: Story = { globals: { theme: "dark" } };
export const Disabled: Story = { args: { clipboardDisabled: true } };
export const ExtractionEnabled: Story = { args: { localEnabled: true } };
export const CalculatingStorage: Story = { args: { storageRefreshing: true } };
export const MigrationChecking: Story = { args: { migration: "checking" } };
export const Migrating: Story = { args: { migration: "migrating" } };
export const Migrated: Story = { args: { migration: "done" } };
export const NothingToMigrate: Story = { args: { migration: "done", migrationEmpty: true } };
export const OldDatabaseMissing: Story = { args: { migration: "not_found" } };
export const MigrationFailed: Story = { args: { migration: "error", operationFailure: true } };
export const ControlsAndMigration: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "30 天" }));
    await userEvent.click(canvas.getByRole("button", { name: "永久" }));
    await expect(canvas.getByRole("button", { name: "永久" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "迁移" }));
    await waitFor(() => expect(canvas.getByText("已迁移 3 个分类，128 条数据")).toBeVisible());
  },
};
export const JumpToLocalModel: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "去启用" }));
    await expect(canvas.getByRole("heading", { name: "模型" })).toBeVisible();
    await expect(canvas.getByRole("switch", { name: "启用本地模型" })).toBeVisible();
  },
};
