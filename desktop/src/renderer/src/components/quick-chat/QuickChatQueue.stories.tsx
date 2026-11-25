import type { Meta, StoryObj } from "@storybook/react-vite";
import { QuickChatQueuePreview } from "./QuickChatQueuePreview";

const meta = {
  title: "Quick Chat/Queue",
  component: QuickChatQueuePreview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof QuickChatQueuePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Interactive: Story = {};
