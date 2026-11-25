import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { QuickChatQueue, type QuickChatQueuedInput } from "./QuickChatQueue";
import { QuickChatQueuePreview } from "./QuickChatQueuePreview";

afterEach(cleanup);

test("empty Enter steers the first queued message, then interrupts and sends it", () => {
  render(<QuickChatQueuePreview />);
  const input = screen.getByRole("textbox", { name: "快速对话输入" });
  const queue = screen.getByLabelText("待发送消息");

  fireEvent.keyDown(input, { key: "Enter" });
  expect(within(queue).getByText("插入引导")).toBeInTheDocument();
  expect(within(queue).getByRole("button", { name: "立即发送" })).toBeInTheDocument();

  fireEvent.keyDown(input, { key: "Enter" });
  expect(within(queue).queryByText("再帮我列出需要优先处理的事项。")).not.toBeInTheDocument();
  expect(screen.getByText("已打断当前对话，开始新一轮")).toBeInTheDocument();
  expect(within(queue).getByText("最后整理成一份简短的行动清单。")).toBeInTheDocument();
});

test("typing hides the queue shortcut and Enter enqueues the new message", () => {
  render(<QuickChatQueuePreview />);
  const input = screen.getByRole("textbox", { name: "快速对话输入" });
  const queue = screen.getByLabelText("待发送消息");

  fireEvent.change(input, { target: { value: "新增问题" } });
  expect(within(queue).queryByRole("button", { name: "插入引导" })).not.toBeInTheDocument();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(within(queue).getByText("新增问题")).toBeInTheDocument();
  expect(input).toHaveValue("");
});

test("queue menu closes outside and editing preserves the queue position", async () => {
  render(<QuickChatQueuePreview />);
  const queue = screen.getByLabelText("待发送消息");
  const menu = within(queue).getByRole("button", { name: /消息选项：再帮我/ });

  fireEvent.click(menu);
  expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
  fireEvent.mouseDown(screen.getByRole("textbox", { name: "快速对话输入" }));
  expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();

  fireEvent.click(menu);
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  const edit = screen.getByRole("textbox", { name: "编辑排队消息" });
  fireEvent.change(edit, { target: { value: "修改后的问题" } });
  fireEvent.keyDown(edit, { key: "Enter" });
  expect(await within(queue).findByText("修改后的问题")).toBeInTheDocument();
  expect(within(queue).getByText("最后整理成一份简短的行动清单。")).toBeInTheDocument();
});

test("keeps unsaved edits when the queued message is consumed", () => {
  const recover = vi.fn();
  const item: QuickChatQueuedInput = { id: "q", text: "original", mode: "follow-up" };
  const props = {
    items: [item],
    draft: "",
    onSteer: vi.fn(),
    onInterrupt: vi.fn(),
    onEdit: vi.fn(async () => false),
    onRemove: vi.fn(),
    onRecoverEdit: recover,
  };
  const { rerender } = render(<QuickChatQueue {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "消息选项：original" }));
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.change(screen.getByRole("textbox", { name: "编辑排队消息" }), {
    target: { value: "unfinished edit" },
  });
  rerender(<QuickChatQueue {...props} items={[]} />);
  expect(screen.getByRole("status")).toHaveTextContent("编辑未保存");
  expect(screen.getByRole("textbox", { name: "未保存的编辑" })).toHaveValue("unfinished edit");
  fireEvent.click(screen.getByRole("button", { name: "放入输入框" }));
  expect(recover).toHaveBeenCalledWith("unfinished edit");
});
