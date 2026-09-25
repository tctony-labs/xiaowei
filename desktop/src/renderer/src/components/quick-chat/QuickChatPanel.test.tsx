import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { QuickChatChatPreview } from "./QuickChatChatPreview";
import { QuickChatPanel, type QuickChatPanelProps } from "./QuickChatPanel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function input() {
  return screen.getByRole("textbox", { name: "快速对话输入" });
}

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}

function send() {
  fireEvent.keyDown(input(), { key: "Enter" });
}

test("missing default model reports an error and prevents sending without adding selectors", () => {
  render(<QuickChatChatPreview scenario="missing-default" />);
  type("你好");
  expect(screen.getByRole("alert")).toHaveTextContent("未设置默认模型");
  expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "对话模型" })).toBeNull();
  expect(screen.queryByRole("button", { name: "思考强度" })).toBeNull();
  send();
  expect(screen.queryByRole("article", { name: "用户消息" })).toBeNull();
});

test("IME and Shift+Enter do not send, while Enter sends once and stop retains partial content", () => {
  vi.useFakeTimers();
  render(<QuickChatChatPreview />);
  type("你好");
  fireEvent.compositionStart(input());
  send();
  fireEvent.keyDown(input(), { key: "Escape" });
  expect(screen.getByTestId("quick-chat-viewport")).toHaveAttribute("data-expanded", "true");
  fireEvent.compositionEnd(input());
  fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
  expect(screen.queryByRole("article", { name: "用户消息" })).toBeNull();
  send();
  expect(screen.getAllByRole("article", { name: "用户消息" })).toHaveLength(1);
  type("稍后再问");
  send();
  expect(screen.getAllByRole("article", { name: "用户消息" })).toHaveLength(1);
  act(() => vi.advanceTimersByTime(1200));
  fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
  expect(screen.getByText("已停止")).toBeVisible();
  const partial = screen.getByRole("article", { name: "助手消息" }).textContent;
  act(() => vi.advanceTimersByTime(5000));
  expect(screen.getByRole("article", { name: "助手消息" }).textContent).toBe(partial);
  expect(input()).toHaveValue("稍后再问");
});

test("collapsing retains messages and draft; new conversation cancels and clears the old stream", () => {
  vi.useFakeTimers();
  render(<QuickChatChatPreview />);
  type("记住苹果");
  send();
  type("接下来");
  fireEvent.keyDown(input(), { key: "Escape" });
  act(() => vi.advanceTimersByTime(310));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "搜索" }), { key: "ArrowDown" });
  expect(input()).toHaveValue("接下来");
  expect(screen.getByRole("article", { name: "用户消息" })).toHaveTextContent("记住苹果");
  fireEvent.click(screen.getByRole("button", { name: "新建对话" }));
  expect(input()).toHaveValue("");
  act(() => vi.advanceTimersByTime(5000));
  expect(screen.queryByRole("article", { name: "助手消息" })).toBeNull();
  expect(screen.getByText("输入问题开始对话")).toBeVisible();
});

test("thinking is separate from text; completed replies permit another turn and errors remain visible", () => {
  vi.useFakeTimers();
  const { unmount } = render(<QuickChatChatPreview />);
  type("你好");
  send();
  act(() => vi.advanceTimersByTime(8000));
  expect(screen.getByText("思考过程")).toBeVisible();
  expect(screen.getByRole("article", { name: "助手消息" })).toHaveTextContent("这是模拟的流式回复");
  type("继续");
  expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled();
  unmount();
  render(<QuickChatChatPreview scenario="error" />);
  expect(screen.getByRole("alert")).toHaveTextContent("模型请求失败");
});

test("reopening a completed chat restores the bottom or the user's reading position", () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  const props: QuickChatPanelProps = {
    expanded: true,
    search: <div>search</div>,
    messages: [{ id: "reply", role: "assistant", text: "long reply", status: "complete" }],
    draft: "",
    configured: true,
    generating: false,
    onDraftChange() {},
    onSend() {},
    onStop() {},
    onNewConversation() {},
    onCollapse() {},
  };
  const { rerender } = render(<QuickChatPanel {...props} />);
  const reopen = () => {
    rerender(<QuickChatPanel {...props} expanded={false} />);
    act(() => vi.advanceTimersByTime(310));
    rerender(<QuickChatPanel {...props} />);
    return screen.getByRole("region", { name: "对话消息" });
  };
  expect(reopen().scrollTop).toBe(1000);
  const scroller = screen.getByRole("region", { name: "对话消息" });
  scroller.scrollTop = 200;
  fireEvent.scroll(scroller);
  expect(reopen().scrollTop).toBe(200);
});
