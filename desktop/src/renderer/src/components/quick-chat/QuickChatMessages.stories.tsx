import type { Meta, StoryObj } from "@storybook/react-vite";
import { QuickChatMessagesPreview } from "./QuickChatMessagesPreview";

const meta = {
  title: "Quick Chat/Messages",
  component: QuickChatMessagesPreview,
  render: (args, context) => (
    <QuickChatMessagesPreview key={context.id + JSON.stringify(args)} {...args} />
  ),
  args: { scenario: "plain-answer", narrow: false, actionsFail: false },
  argTypes: {
    scenario: { table: { disable: true } },
    narrow: { name: "窄窗口（360px）", control: "boolean" },
    actionsFail: { name: "复制／链接失败", control: "boolean" },
    waitingAfterTool: {
      name: "工具完成后等待下一次生成",
      control: "boolean",
      if: { arg: "scenario", eq: "waiting" },
    },
    pausedContent: {
      name: "已收到的内容",
      options: ["reasoning", "response", "tool-call"],
      control: {
        type: "select",
        labels: { reasoning: "思考", response: "正文", "tool-call": "工具声明（未执行）" },
      },
      if: { arg: "scenario", eq: "paused" },
    },
    singleTool: {
      name: "工具类型",
      options: ["Read", "Edit", "Bash"],
      control: "select",
      if: { arg: "scenario", eq: "single-tool" },
    },
    toolSequence: {
      name: "连续调用方式",
      options: ["same-tool", "same-arguments", "different-tools", "across-generates"],
      control: {
        type: "select",
        labels: {
          "same-tool": "同名工具，不同参数",
          "same-arguments": "同名工具，相同参数",
          "different-tools": "不同工具",
          "across-generates": "跨 Generate，中间无正文",
        },
      },
      if: { arg: "scenario", eq: "consecutive-tools" },
    },
    toolPhase: {
      name: "当前阶段",
      options: ["executing", "waiting-next-response", "answering", "completed"],
      control: {
        type: "select",
        labels: {
          executing: "工具执行中",
          "waiting-next-response": "工具已结束，等待模型",
          answering: "最终回复输出中",
          completed: "Run 正常完成",
        },
      },
      if: { arg: "scenario", eq: "single-tool" },
    },
    emptyAfter: {
      name: "空回复之前的内容",
      options: ["no-content", "reasoning", "tool"],
      control: {
        type: "select",
        labels: { "no-content": "没有内容", reasoning: "只有思考", tool: "已有正文和工具" },
      },
      if: { arg: "scenario", eq: "empty-final-answer" },
    },
    failureAt: {
      name: "失败位置",
      options: ["before-output", "reasoning", "response", "after-tools", "unknown-tool"],
      control: {
        type: "select",
        labels: {
          "before-output": "尚无输出",
          reasoning: "思考中",
          response: "正文输出中",
          "after-tools": "工具完成后的模型调用",
          "unknown-tool": "工具结果未知",
        },
      },
      if: { arg: "scenario", eq: "failed" },
    },
    stopAt: {
      name: "停止位置",
      options: ["response", "tool"],
      control: { type: "select", labels: { response: "正文输出中", tool: "工具执行中" } },
      if: { arg: "scenario", eq: "stopped" },
    },
    streamMarkdown: {
      name: "流式输出（含未闭合代码）",
      control: "boolean",
      if: { arg: "scenario", eq: "markdown" },
    },
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "按 Generate 与工具执行状态预览。明暗主题使用工具栏，窄屏及场景变体使用控件。" +
          "固定数据，不执行真实工具。",
      },
    },
  },
} satisfies Meta<typeof QuickChatMessagesPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WaitingForFirstData: Story = {
  name: "01 尚未收到数据：3 秒等待提示",
  args: { scenario: "waiting", waitingAfterTool: false },
  parameters: {
    docs: { description: { story: "开始只有流光，3 秒后出现等待文案；重新演示会重新计时。" } },
  },
};

export const PausedAfterData: Story = {
  name: "02 收到内容后停顿：持续流光",
  args: { scenario: "paused", pausedContent: "reasoning" },
  parameters: {
    docs: { description: { story: "不再追加数据，持续流光；不会在 3 秒后出现等待文案。" } },
  },
};

export const AnswerWithoutTools: Story = { name: "03 无工具的最终回复" };

export const SingleTool: Story = {
  name: "04 单次工具调用",
  args: { scenario: "single-tool", singleTool: "Read", toolPhase: "completed" },
};

export const ConsecutiveTools: Story = {
  name: "05 连续工具调用：中间无正文",
  args: { scenario: "consecutive-tools", toolSequence: "same-tool", toolPhase: "executing" },
  argTypes: { toolPhase: { name: "当前阶段", if: { arg: "scenario", eq: "consecutive-tools" } } },
};

export const ToolsWithResponse: Story = {
  name: "06 工具之间有正文",
  args: { scenario: "tools-with-response", toolPhase: "completed" },
  argTypes: { toolPhase: { name: "当前阶段", if: { arg: "scenario", eq: "tools-with-response" } } },
};

export const EmptyFinalAnswer: Story = {
  name: "07 最终回复为空",
  args: { scenario: "empty-final-answer", emptyAfter: "tool" },
};

export const ToolErrorRecovered: Story = {
  name: "08 工具失败，Run 正常完成",
  args: { scenario: "tool-error-recovered" },
};

export const RunFailed: Story = {
  name: "09 Run 失败",
  args: { scenario: "failed", failureAt: "after-tools" },
};

export const RunStopped: Story = {
  name: "10 用户停止",
  args: { scenario: "stopped", stopAt: "tool" },
};

export const MarkdownAndCopy: Story = {
  name: "11 Markdown、代码与复制",
  args: { scenario: "markdown", streamMarkdown: false },
};

export const LongContent: Story = {
  name: "12 长内容与横向滚动",
  args: { scenario: "long-content", narrow: true },
};
