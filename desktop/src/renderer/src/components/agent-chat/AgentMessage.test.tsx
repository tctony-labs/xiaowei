import { create } from "@bufbuild/protobuf";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  AgentInteractionStatus,
  AgentItemSchema,
  AgentToolCallSchema,
  AgentToolStatus,
} from "xiaowei-contracts";
import { messagePreview } from "../quick-chat/message-preview-fixtures";
import { QuickChatMessagesPreview } from "../quick-chat/QuickChatMessagesPreview";
import type { QuickChatMessage } from "../quick-chat/QuickChatPanel";
import { AgentMessage } from "./AgentMessage";
import { AgentReasoning } from "./AgentReasoning";
import { AgentToolCall } from "./AgentToolCall";
import { chatMessages } from "./agent-events";
import { messageBlocks } from "./message-blocks";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function textMessage(text: string, status: QuickChatMessage["status"] = "complete") {
  return {
    id: "reply",
    role: "assistant" as const,
    text,
    blocks: [{ id: "text", kind: "text" as const, text }],
    status,
  };
}

test("consecutive questions stay visible between collapsed tool groups", () => {
  const items = ["Read", "Read", "AskUserQuestion", "AskUserQuestion", "Write"].map((name, index) =>
    create(AgentItemSchema, {
      itemId: `item-${index}`,
      content: {
        case: "toolCall",
        value: {
          toolId: `tool-${index}`,
          name,
          status: AgentToolStatus.COMPLETED,
          interaction:
            name === "AskUserQuestion"
              ? {
                  interactionId: `question-${index}`,
                  revision: 1n,
                  status: AgentInteractionStatus.PENDING,
                  request: {
                    case: "question",
                    value: { question: `问题 ${index}` },
                  },
                }
              : undefined,
        },
      },
    }),
  );
  const { container } = render(
    <AgentMessage
      message={{
        id: "run",
        role: "assistant",
        status: "generating",
        blocks: messageBlocks(items),
      }}
      onCopy={vi.fn()}
      onOpenUrl={vi.fn()}
    />,
  );
  for (const card of screen.getAllByRole("region", { name: "待回答问题" })) {
    expect(card).toBeVisible();
    expect(card.closest(".agent-tool-group")).toBeNull();
  }
  expect(screen.getByRole("button", { name: "展开工具调用" })).toHaveTextContent("读取文件");
  expect(screen.getByText("问题 2")).toBeVisible();
  expect(screen.getByText("问题 3")).toBeVisible();
  expect(container.querySelector(".agent-shimmer")).toBeNull();
});

test("the first-data waiting label appears at 3 seconds and is cleared by output", () => {
  vi.useFakeTimers();
  const generation = { id: "gen", startedAtMs: Date.now(), receivedContent: false };
  const props = { onCopy: vi.fn(async () => {}), onOpenUrl: vi.fn(async () => {}) };
  const { container, rerender } = render(
    <AgentMessage {...props} generation={generation} message={textMessage("", "generating")} />,
  );
  expect(screen.queryByText("等待模型响应")).toBeNull();
  act(() => vi.advanceTimersByTime(2999));
  expect(screen.queryByText("等待模型响应")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByText("等待模型响应")).toBeVisible();

  rerender(
    <AgentMessage
      {...props}
      generation={{ ...generation, receivedContent: true, activeBlockId: "text" }}
      message={textMessage("已收到部分正文", "generating")}
    />,
  );
  act(() => vi.advanceTimersByTime(10_000));
  expect(screen.queryByText("等待模型响应")).toBeNull();
  expect(container.querySelector('[data-streaming="true"]')).not.toBeNull();

  rerender(
    <AgentMessage {...props} generation={generation} message={textMessage("正文", "cancelled")} />,
  );
  expect(container.querySelector('[data-streaming="true"], .agent-shimmer')).toBeNull();
});

test.each(["reasoning", "response", "tool-call"] as const)(
  "paused %s output keeps shimmering without returning to the waiting label",
  (pausedContent) => {
    vi.useFakeTimers();
    const { container } = render(
      <QuickChatMessagesPreview scenario="paused" pausedContent={pausedContent} />,
    );
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByText("等待模型响应")).toBeNull();
    expect(container.querySelector('[data-streaming="true"], .agent-shimmer')).not.toBeNull();
    expect(screen.queryByLabelText(/· 执行中/)).toBeNull();
  },
);

test("a new Generate has its own first-data wait and cannot animate an old response", () => {
  vi.useFakeTimers();
  const message = textMessage("上一轮已结束的说明", "generating");
  const props = { onCopy: vi.fn(async () => {}), onOpenUrl: vi.fn(async () => {}) };
  const { container, rerender } = render(
    <AgentMessage
      {...props}
      message={message}
      generation={{
        id: "gen-1",
        startedAtMs: Date.now(),
        receivedContent: true,
        activeBlockId: "text",
      }}
    />,
  );
  act(() => vi.advanceTimersByTime(10_000));
  rerender(
    <AgentMessage
      {...props}
      message={message}
      generation={{ id: "gen-2", startedAtMs: Date.now(), receivedContent: false }}
    />,
  );
  expect(container.querySelector('[data-streaming="true"]')).toBeNull();
  act(() => vi.advanceTimersByTime(2999));
  expect(screen.queryByText("等待模型响应")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByText("等待模型响应")).toBeVisible();
});

test.each(["no-content", "reasoning", "tool"] as const)(
  "an empty final response after %s never copies earlier process text as the answer",
  (emptyAfter) => {
    render(<QuickChatMessagesPreview scenario="empty-final-answer" emptyAfter={emptyAfter} />);
    expect(screen.getByText("未返回回复内容")).toBeVisible();
    expect(screen.queryByRole("button", { name: "复制回复" })).toBeNull();
    expect(screen.queryByText("已停止")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    if (emptyAfter === "tool") {
      expect(screen.getByText("我先读取一下配置。")).not.toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "展开执行过程" }));
      expect(screen.getByText("我先读取一下配置。")).toBeVisible();
      expect(screen.getByLabelText(/^读取(?:文件| config\.json) · 已完成$/)).toBeVisible();
    }
  },
);

test("whitespace-only final text has no reply copy action", () => {
  render(
    <AgentMessage
      message={textMessage(" \n ")}
      finalResponseBlockIds={["text"]}
      onCopy={vi.fn(async () => {})}
      onOpenUrl={vi.fn(async () => {})}
    />,
  );
  expect(screen.getByText("未返回回复内容")).toBeVisible();
  expect(screen.queryByRole("button", { name: "复制回复" })).toBeNull();
});

test("message time follows the copy button, uses Run start and refreshes every 30 seconds", () => {
  vi.useFakeTimers();
  const timestampMs = BigInt(Date.now() - 30_000);
  const { container } = render(
    <AgentMessage
      message={{ ...textMessage("最终回复"), timestampMs }}
      finalResponseBlockIds={["text"]}
      onCopy={vi.fn(async () => {})}
      onOpenUrl={vi.fn(async () => {})}
    />,
  );
  const copy = screen.getByRole("button", { name: "复制回复" });
  const time = container.querySelector("time") as HTMLElement;
  expect(time).toHaveTextContent("刚刚");
  expect(copy.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  act(() => vi.advanceTimersByTime(30_000));
  expect(time).toHaveTextContent("1 分钟前");
});

test("the panel places explanation, tool and result in their actual order", () => {
  render(<QuickChatMessagesPreview />);
  expect(screen.getByRole("button", { name: "展开执行过程" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(screen.getByText("我先找一下配置文件。")).not.toBeVisible();
  expect(screen.getByText("超时时间是", { exact: false })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "展开执行过程" }));
  const intro = screen.getByText("我先找一下配置文件。");
  const glob = screen.getByLabelText(/^查找文件(?: config\.json)? · 已完成$/);
  const middle = screen.getByText("找到了，我读取一下。");
  const read = screen.getByLabelText(/^读取(?:文件| config\.json) · 已完成$/);
  const answer = screen.getByText("超时时间是", { exact: false });
  const sequence = [intro, glob, middle, read, answer];
  sequence.slice(1).forEach((element, index) => {
    expect(
      sequence[index].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  const reasoning = screen.getByLabelText("思考过程");
  expect(reasoning).toHaveTextContent("先定位配置，再读取其中的超时字段。");
  const fullReasoning = reasoning.closest("details")?.querySelector("p") as HTMLElement;
  expect(fullReasoning).not.toBeVisible();
  fireEvent.click(reasoning);
  expect(fullReasoning).toBeVisible();
});

test("text separates tool groups and their summaries show the current call", () => {
  const tool = (id: string, name: string, status = AgentToolStatus.COMPLETED) => ({
    id,
    kind: "tool" as const,
    call: create(AgentToolCallSchema, { name, status }),
  });
  render(
    <AgentMessage
      message={{
        id: "run",
        role: "assistant",
        text: "",
        status: "generating",
        blocks: [
          { id: "intro", kind: "text", text: "我先找一下配置文件。" },
          tool("glob", "Glob"),
          tool("grep", "Grep"),
          { id: "middle", kind: "text", text: "找到了，我读取一下。" },
          tool("read-first", "Read"),
          tool("read-second", "Read", AgentToolStatus.PENDING),
        ],
      }}
      onCopy={vi.fn(async () => {})}
      onOpenUrl={vi.fn(async () => {})}
    />,
  );
  const toggles = screen.getAllByRole("button", { name: "展开工具调用" });
  expect(toggles).toHaveLength(2);
  expect(screen.getByText("我先找一下配置文件。")).toBeVisible();
  expect(screen.getByText("找到了，我读取一下。")).toBeVisible();
  expect(screen.getByLabelText(/^查找文件(?: config\.json)? · 已完成$/)).not.toBeVisible();
  expect(toggles[1]).toHaveTextContent("读取文件");
  expect(toggles[1]).toHaveAttribute("aria-busy", "true");
  fireEvent.click(toggles[0]);
  const glob = screen.getByLabelText(/^查找文件(?: config\.json)? · 已完成$/);
  const grep = screen.getByLabelText("搜索内容 · 已完成");
  const middle = screen.getByText("找到了，我读取一下。");
  expect(glob).toBeVisible();
  expect(grep).toBeVisible();
  expect(glob.compareDocumentPosition(grep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(grep.compareDocumentPosition(middle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(toggles[1]);
  expect(screen.getByLabelText("读取文件 · 执行中")).toBeVisible();
});

test("a growing tool group preserves its expanded tool through updates and Run completion", () => {
  const first = create(AgentToolCallSchema, {
    name: "Read",
    status: AgentToolStatus.COMPLETED,
    output: "config",
  });
  const message: QuickChatMessage = {
    id: "reply",
    role: "assistant",
    text: "",
    status: "generating",
    blocks: [{ id: "read", kind: "tool", call: first }],
  };
  const props = { onCopy: vi.fn(async () => {}), onOpenUrl: vi.fn(async () => {}) };
  const { rerender } = render(<AgentMessage {...props} message={message} />);
  const read = screen.getByLabelText(/^读取(?:文件| config\.json) · 已完成$/).closest("details");
  fireEvent.click(screen.getByLabelText(/^读取(?:文件| config\.json) · 已完成$/));

  const second = create(AgentToolCallSchema, {
    name: "Grep",
    status: AgentToolStatus.FAILED,
    output: "Invalid regex",
  });
  const growing: QuickChatMessage = {
    ...message,
    blocks: [
      ...(message.blocks ?? []),
      { id: "empty", kind: "text", text: "" },
      { id: "grep", kind: "tool", call: second },
    ],
  };
  rerender(<AgentMessage {...props} message={growing} />);
  expect(screen.getByRole("button", { name: "展开工具调用" })).toHaveTextContent("1 项异常");
  fireEvent.click(screen.getByRole("button", { name: "展开工具调用" }));
  expect(screen.getByLabelText(/^读取(?:文件| config\.json) · 已完成$/).closest("details")).toBe(
    read,
  );
  expect(read).toHaveAttribute("open");

  rerender(
    <AgentMessage
      {...props}
      finalResponseBlockIds={["answer"]}
      message={{
        ...growing,
        status: "complete",
        blocks: [...(growing.blocks ?? []), { id: "answer", kind: "text", text: "检查结束。" }],
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "展开执行过程" }));
  expect(screen.getByRole("button", { name: "收起工具调用" })).toBeVisible();
  expect(read).toBeVisible();
  expect(read).toHaveAttribute("open");
});

test("reasoning previews the latest visible line and retains full text on expansion", () => {
  const text = "**定位配置**\r\n先搜索文件。\r\n\r\n正在读取 **config.json**\r\n<!-- note -->\r\n";
  const { rerender } = render(<AgentReasoning text={text} active />);
  const summary = screen.getByLabelText("正在思考");
  expect(summary).toHaveTextContent("正在读取 config.json");
  expect(summary).not.toHaveTextContent("先搜索文件");
  const body = summary.closest("details")?.querySelector("p") as HTMLElement;
  expect(body).not.toBeVisible();
  fireEvent.click(summary);
  expect(body).toBeVisible();
  expect(body).toHaveTextContent("先搜索文件。");

  rerender(<AgentReasoning text={`${text}正在检查超时。\n<!-- unfinished`} active />);
  expect(screen.getByLabelText("正在思考")).toHaveTextContent("正在检查超时。");
  expect(body).toBeVisible();
  rerender(<AgentReasoning text={`${text}检查完成。`} active={false} />);
  expect(screen.getByLabelText("思考过程")).toHaveTextContent("检查完成。");
  expect(body).toBeVisible();
});

test.each(["generating", "cancelled", "failed"] as const)(
  "%s keeps process commentary and tools visible without automatic folding",
  (status) => {
    const frame = messagePreview({ scenario: "tools-with-response", toolPhase: "answering" }, 0);
    const message = chatMessages(frame.session)[1];
    message.status = status;
    if (status === "failed") message.error = "后续模型调用失败";
    render(
      <AgentMessage
        message={message}
        generation={status === "generating" ? frame.generation : undefined}
        onCopy={vi.fn(async () => {})}
        onOpenUrl={vi.fn(async () => {})}
      />,
    );
    expect(screen.queryByRole("button", { name: "展开执行过程" })).toBeNull();
    expect(screen.getByText("我先找一下配置文件。")).toBeVisible();
    expect(screen.getByLabelText(/^查找文件(?: config\.json)? · 已完成$/)).toBeVisible();
    expect(screen.getByText("找到了，我读取一下。")).toBeVisible();
    if (status === "failed") expect(screen.getByRole("alert")).toBeVisible();
  },
);

test("completed summary shows only total duration and retains errors in details", () => {
  render(<QuickChatMessagesPreview scenario="tool-error-recovered" />);
  const summary = screen.getByRole("button", { name: "展开执行过程" });
  expect(summary).toHaveTextContent("用时 3.2 秒");
  expect(summary).not.toHaveTextContent(/执行过程|工具调用|异常/);
  expect(screen.getByText("文件读取失败，请先检查文件访问权限。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "展开执行过程" }));
  fireEvent.click(screen.getByLabelText("读取 config.json · 失败"));
  const read = screen
    .getByLabelText("读取 config.json · 失败")
    .closest("details") as HTMLDetailsElement;
  const output = within(read).getByRole("region", { name: "工具输出" });
  expect(output).toHaveTextContent("文件读取失败");
});

test("completion folds activity and keeps manual expansion through updates", async () => {
  const call = create(AgentToolCallSchema, {
    name: "Read",
    status: AgentToolStatus.COMPLETED,
    output: "timeout: 30",
  });
  const message: QuickChatMessage = {
    id: "reply",
    role: "assistant",
    text: "",
    status: "generating",
    blocks: [
      { id: "intro", kind: "text", text: "我先读取文件。" },
      { id: "read", kind: "tool", call },
      { id: "answer", kind: "text", text: "超时时间是 **30 秒**。" },
    ],
  };
  const onCopy = vi.fn(async () => {});
  const props = { onCopy, onOpenUrl: vi.fn(async () => {}), finalResponseBlockIds: ["answer"] };
  const { rerender } = render(<AgentMessage {...props} message={message} />);
  const tool = screen.getByLabelText(/^读取(?:文件| config\.json) · 已完成$/).closest("details");
  fireEvent.click(screen.getByLabelText(/^读取(?:文件| config\.json) · 已完成$/));
  expect(tool).toHaveAttribute("open");
  const completed: QuickChatMessage = { ...message, status: "complete", durationMs: 1250n };
  rerender(<AgentMessage {...props} message={completed} />);
  expect(screen.getByText("我先读取文件。")).not.toBeVisible();
  expect(screen.getByText("用时 1.3 秒")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "展开执行过程" }));
  expect(screen.getByLabelText(/^读取(?:文件| config\.json) · 已完成$/).closest("details")).toBe(
    tool,
  );
  expect(tool).toHaveAttribute("open");
  expect(screen.getByRole("region", { name: "工具输出" })).toHaveTextContent("timeout: 30");

  rerender(
    <AgentMessage {...props} message={{ ...completed, blocks: [...(completed.blocks ?? [])] }} />,
  );
  expect(screen.getByRole("button", { name: "收起执行过程" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "复制回复" }));
  await screen.findByText("已复制");
  expect(onCopy).toHaveBeenCalledExactlyOnceWith("超时时间是 **30 秒**。");
});

test("GFM renders while reply and code copy preserve raw source", async () => {
  const source = [
    "## 标题",
    "",
    "**粗体** 和 `inline`",
    "",
    "| 字段 | 值 |",
    "| --- | --- |",
    "| timeout | 30 |",
    "",
    "- [x] 已检查",
    "",
    "```ts",
    "const timeout = 30;",
    "```",
    "",
    "[说明](https://example.com/docs)",
  ].join("\n");
  const onCopy = vi.fn(async () => {});
  const onOpenUrl = vi.fn(async () => {});
  render(<AgentMessage message={textMessage(source)} onCopy={onCopy} onOpenUrl={onOpenUrl} />);

  expect(screen.getByRole("heading", { name: "标题" })).toBeVisible();
  expect(screen.getByRole("table")).toHaveTextContent("timeout30");
  expect(screen.getByRole("checkbox")).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "复制回复" }));
  expect(await screen.findByText("已复制")).toBeVisible();
  expect(onCopy).toHaveBeenLastCalledWith(source);
  fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
  expect(onCopy).toHaveBeenLastCalledWith("const timeout = 30;\n");
  fireEvent.click(screen.getByRole("link", { name: "说明" }));
  expect(onOpenUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
});

test("streaming fences keep code position through updates and stop", () => {
  const onCopy = vi.fn(async () => {});
  const onOpenUrl = vi.fn(async () => {});
  const props = { onCopy, onOpenUrl };
  const generation = { id: "gen", startedAtMs: Date.now(), receivedContent: false };
  const { rerender } = render(
    <AgentMessage {...props} generation={generation} message={textMessage("", "generating")} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("…");
  const partial = "说明\n\n```ts\nconst timeout =";
  rerender(
    <AgentMessage
      {...props}
      generation={{ ...generation, receivedContent: true, activeBlockId: "text" }}
      message={textMessage(partial, "generating")}
    />,
  );
  const code = screen.getByRole("region", { name: "代码块" });
  code.scrollLeft = 64;
  expect(code).toHaveTextContent("const timeout =");
  expect(screen.queryByText("等待模型响应")).toBeNull();
  expect(screen.queryByRole("button", { name: "复制回复" })).toBeNull();

  const complete = "说明\n\n```ts\nconst timeout = 30;\n```";
  rerender(<AgentMessage {...props} message={textMessage(complete, "cancelled")} />);
  expect(screen.getByRole("region", { name: "代码块" })).toBe(code);
  expect(code.scrollLeft).toBe(64);
  expect(code).toHaveTextContent("const timeout = 30;");
  expect(screen.getByText("已停止")).toBeVisible();
  expect(screen.getByRole("button", { name: "复制回复" })).toBeVisible();
});

test("single tool rows start with an icon and formatted text, with the chevron last", () => {
  render(
    <AgentToolCall
      call={create(AgentToolCallSchema, {
        name: "Read",
        status: AgentToolStatus.COMPLETED,
        argumentsJson: '{"path":"/workspace/config.json"}',
      })}
    />,
  );
  const summary = screen.getByLabelText("读取 config.json · 已完成");
  expect(summary.firstElementChild).toHaveAttribute("data-icon", "file");
  expect(summary.querySelector(".agent-tool-label")).toHaveTextContent("读取 config.json");
  expect(summary.querySelector(".agent-tool-label")).toHaveAttribute(
    "title",
    "/workspace/config.json",
  );
  expect(summary.lastElementChild).toHaveClass("agent-disclosure");
  expect(summary).not.toHaveTextContent(/Read|已完成/);
});

test("tool completion preserves disclosure state and separates parameters, output and diff", () => {
  const call = create(AgentToolCallSchema, {
    name: "Edit",
    status: AgentToolStatus.PENDING,
    argumentsJson: '{"path":"/workspace/配置.json","old_string":"20","new_string":"30"}',
  });
  const message: QuickChatMessage = {
    id: "reply",
    role: "assistant",
    text: "",
    status: "generating",
    blocks: [{ id: "edit", kind: "tool", call }],
  };
  const props = { onCopy: vi.fn(async () => {}), onOpenUrl: vi.fn(async () => {}) };
  const { rerender } = render(<AgentMessage {...props} message={message} />);
  const details = screen.getByLabelText("修改 配置.json · 执行中").closest("details");
  fireEvent.click(screen.getByLabelText("修改 配置.json · 执行中"));
  expect(details).toHaveAttribute("open");
  expect(screen.getByRole("region", { name: "工具参数" })).toHaveTextContent("old_string");
  expect(screen.getByRole("region", { name: "工具输出" })).toHaveTextContent("等待执行结果");
  expect(screen.queryByText(/毫秒|秒/)).toBeNull();

  rerender(
    <AgentMessage
      {...props}
      message={{
        ...message,
        blocks: [
          {
            id: "edit",
            kind: "tool",
            call: create(AgentToolCallSchema, {
              ...call,
              status: AgentToolStatus.COMPLETED,
              output: "已更新配置",
              durationMs: 0n,
              metadataJson: JSON.stringify({
                filediff: {
                  additions: 1,
                  deletions: 1,
                  unified: "-timeout: 20\n+timeout: 30\n",
                },
              }),
            }),
          },
        ],
      }}
    />,
  );
  expect(screen.getByLabelText("修改 配置.json · 已完成").closest("details")).toBe(details);
  expect(screen.getByLabelText("修改 配置.json · 已完成")).not.toHaveTextContent("已完成");
  expect(screen.getByLabelText("修改 配置.json · 已完成")).toHaveAttribute("aria-busy", "false");
  expect(details).toHaveAttribute("open");
  expect(screen.queryByText(/毫秒|秒/)).toBeNull();
  expect(screen.getByRole("region", { name: "工具输出" })).toHaveTextContent("已更新配置");
  expect(screen.getByRole("region", { name: "文件改动" })).toHaveTextContent("+timeout: 30");
});

test.each([
  [AgentToolStatus.FAILED, "失败"],
  [AgentToolStatus.CANCELLED, "已停止"],
  [AgentToolStatus.SKIPPED, "未执行"],
  [AgentToolStatus.RESULT_UNKNOWN, "结果未知"],
  [AgentToolStatus.UNSPECIFIED, "状态未知"],
])("tool state %s has a distinct label %s without showing duration", (status, label) => {
  render(
    <AgentToolCall
      call={create(AgentToolCallSchema, {
        name: "Bash",
        status,
        durationMs: 1250n,
        argumentsJson: "{invalid",
        metadataJson: "{invalid",
      })}
    />,
  );
  fireEvent.click(screen.getByLabelText(`执行命令 · ${label}`));
  expect(screen.getByRole("region", { name: "工具参数" })).toHaveTextContent("{invalid");
  expect(screen.getByRole("region", { name: "工具输出" })).toHaveTextContent("无输出");
  expect(screen.queryByText(/毫秒|秒/)).toBeNull();
});

test("copy failure remains retryable and a failed link never claims to have opened", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const onCopy = vi.fn(async () => {
    throw new Error("clipboard unavailable");
  });
  const onOpenUrl = vi.fn(async () => {
    throw new Error("open failed");
  });
  render(
    <AgentMessage
      message={textMessage("[说明](https://example.com)")}
      onCopy={onCopy}
      onOpenUrl={onOpenUrl}
    />,
  );
  const copy = screen.getByRole("button", { name: "复制回复" });
  fireEvent.click(copy);
  expect(await screen.findByRole("status")).toHaveTextContent("复制失败，请重试");
  expect(screen.queryByText("已复制")).toBeNull();
  fireEvent.click(copy);
  expect(onCopy).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("link", { name: "说明" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("链接打开失败");
});

test("long Chinese text copies in full, excluding reasoning and tools", async () => {
  const text = "中文🙂内容\n".repeat(10000);
  const onCopy = vi.fn(async () => {});
  const onOpenUrl = vi.fn(async () => {});
  const message: QuickChatMessage = textMessage(text);
  message.blocks?.unshift(
    { id: "thought", kind: "reasoning", text: "不复制的思考" },
    { id: "empty", kind: "text", text: "" },
    {
      id: "tool",
      kind: "tool",
      call: create(AgentToolCallSchema, {
        name: "Read",
        status: AgentToolStatus.COMPLETED,
        output: "不复制的工具输出",
      }),
    },
  );
  render(
    <AgentMessage
      message={message}
      finalResponseBlockIds={["text"]}
      onCopy={onCopy}
      onOpenUrl={onOpenUrl}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "复制回复" }));
  await screen.findByText("已复制");
  expect(onCopy).toHaveBeenLastCalledWith(text);
  cleanup();
  render(
    <AgentMessage
      message={{ id: "user", role: "user", text: "**原始输入**\n第二行" }}
      onCopy={onCopy}
      onOpenUrl={onOpenUrl}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
  expect(onCopy).toHaveBeenLastCalledWith("**原始输入**\n第二行");
});

test("raw HTML and unsafe links stay inert while image URLs require an explicit click", () => {
  const onOpenUrl = vi.fn(async () => {});
  const { container } = render(
    <AgentMessage
      message={textMessage(
        [
          "[危险](javascript:alert(1))",
          "",
          '<script>alert("x")</script>',
          "",
          "![配置图](https://example.com/image.png)",
        ].join("\n"),
      )}
      onCopy={vi.fn(async () => {})}
      onOpenUrl={onOpenUrl}
    />,
  );
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(screen.queryByRole("link", { name: "危险" })).toBeNull();
  expect(onOpenUrl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("link", { name: "配置图" }));
  expect(onOpenUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/image.png");
});
