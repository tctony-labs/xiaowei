import type { Meta, StoryObj } from "@storybook/react-vite";
import { QuickChatChatPreview } from "./QuickChatChatPreview";

const meta = {
  title: "Quick Chat/Chat",
  component: QuickChatChatPreview,
  render: (args, context) => <QuickChatChatPreview key={context.id} {...args} />,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "最小内存对话预览：使用默认模型与思考强度，不提供选择控件。回复为模拟流，不调用真实模型。",
      },
    },
  },
} satisfies Meta<typeof QuickChatChatPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const Search: Story = { args: { initiallyExpanded: false } };
export const MissingDefault: Story = { args: { scenario: "missing-default" } };
export const Loading: Story = { args: { scenario: "loading" } };
export const StreamingText: Story = { args: { scenario: "text" } };
export const Thinking: Story = { args: { scenario: "thinking" } };
export const Complete: Story = { args: { scenario: "complete" } };
export const Failed: Story = { args: { scenario: "error" } };
export const Stopped: Story = { args: { scenario: "stopped" } };
