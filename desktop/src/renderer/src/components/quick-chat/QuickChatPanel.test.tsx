import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

test("no available models shows an empty state and prevents sending without adding selectors", () => {
  render(<QuickChatChatPreview scenario="no-models" />);
  type("你好");
  expect(screen.getByText("暂无可用模型")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "设置 - 模型" })).toBeVisible();
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

function menuPanel(overrides: Partial<QuickChatPanelProps> = {}) {
  const props: QuickChatPanelProps = {
    expanded: true,
    search: <div>search</div>,
    messages: [{ id: "user", role: "user", text: "Hello" }],
    sessionId: "session-id",
    draft: "",
    configured: true,
    generating: false,
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onNewConversation: vi.fn(),
    onCollapse: vi.fn(),
    ...overrides,
  };
  render(<QuickChatPanel {...props} />);
  return props;
}

test("unimplemented title actions show a toast in a conversation without pretending to edit", () => {
  menuPanel();
  expect(screen.getByRole("button", { name: "新建对话" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "选择会话" }));
  expect(screen.getByRole("status")).toHaveTextContent("暂未实现");
  expect(screen.queryByText("暂无对话")).toBeNull();
  for (const name of ["重命名", "更新标题", "归档"]) {
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("button", { name })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("status")).toHaveTextContent("暂未实现");
    expect(screen.queryByRole("textbox", { name: "对话标题" })).toBeNull();
    expect(screen.queryByRole("button", { name: "归档" })).toBeNull();
  }
  expect(screen.queryByText(/默认可写/)).toBeNull();
});

test("toast expiration restarts on repeated clicks and Escape closes the menu before collapsing chat", () => {
  vi.useFakeTimers();
  const props = menuPanel();
  fireEvent.click(screen.getByRole("button", { name: "选择会话" }));
  act(() => vi.advanceTimersByTime(2000));
  fireEvent.click(screen.getByRole("button", { name: "选择会话" }));
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByRole("status")).toHaveTextContent("暂未实现");
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole("status")).toBeNull();
  const more = screen.getByRole("button", { name: "更多操作" });
  fireEvent.click(more);
  fireEvent.keyDown(input(), { key: "Escape" });
  expect(screen.queryByRole("button", { name: "重命名" })).toBeNull();
  expect(props.onCollapse).not.toHaveBeenCalled();
  fireEvent.keyDown(input(), { key: "Escape" });
  expect(props.onCollapse).toHaveBeenCalledTimes(1);
});

test("copy uses the real session ID; deletion requires confirmation and never invokes new conversation", async () => {
  const props = menuPanel({
    sessionId: "session-id",
    onCopySessionId: vi.fn(async () => {}),
    onDeleteConversation: vi.fn(),
  });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("button", { name: "Session ID" }));
  expect(props.onCopySessionId).toHaveBeenCalledExactlyOnceWith("session-id");
  expect(await screen.findByRole("status")).toHaveTextContent("已复制");
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("button", { name: "删除会话" }));
  expect(props.onNewConversation).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
  expect(props.onNewConversation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("button", { name: "删除会话" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除" }));
  expect(props.onDeleteConversation).toHaveBeenCalledTimes(1);
  expect(props.onNewConversation).not.toHaveBeenCalled();
});

test.each([null, "empty-session"])("blank chat (%s) hides more actions even with a draft", (sessionId) => {
  menuPanel({ sessionId, messages: [], draft: "unsent draft" });
  expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  expect(screen.getByRole("button", { name: "新建对话" })).toBeVisible();
  expect(screen.getByRole("button", { name: "选择会话" })).toBeVisible();
  expect(input()).toHaveValue("unsent draft");
});

test("the session menu lists actual sessions and sends the selected ID to the adapter", () => {
  const props = menuPanel({
    sessionId: "first",
    sessions: [
      { id: "first", title: "First" },
      { id: "second", title: "Second" },
    ],
    onListSessions: vi.fn(),
    onSwitchSession: vi.fn(),
  });
  fireEvent.click(screen.getByRole("button", { name: "选择会话" }));
  expect(props.onListSessions).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Second" }));
  expect(props.onSwitchSession).toHaveBeenCalledExactlyOnceWith("second");
  expect(props.onNewConversation).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Second" })).toBeNull();
});

test("switching sessions restores each session's reading position", () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  const props: QuickChatPanelProps = {
    expanded: true,
    search: <div>search</div>,
    sessionId: "first",
    messages: [{ id: "first-reply", role: "assistant", text: "First reply", status: "complete" }],
    draft: "",
    configured: true,
    generating: false,
    onDraftChange() {},
    onSend() {},
    onStop() {},
    onNewConversation() {},
    onCollapse() {},
  };
  const second: QuickChatPanelProps = {
    ...props,
    sessionId: "second",
    messages: [{ id: "second-reply", role: "assistant", text: "Second reply", status: "complete" }],
  };
  const { rerender } = render(<QuickChatPanel {...props} />);
  const scroller = screen.getByRole("region", { name: "对话消息" });
  scroller.scrollTop = 100;
  fireEvent.scroll(scroller);
  rerender(<QuickChatPanel {...second} />);
  expect(scroller.scrollTop).toBe(1000);
  scroller.scrollTop = 400;
  fireEvent.scroll(scroller);
  rerender(<QuickChatPanel {...props} />);
  expect(scroller.scrollTop).toBe(100);
  rerender(<QuickChatPanel {...second} />);
  expect(scroller.scrollTop).toBe(400);
});

test("a clipboard failure shows a retry toast instead of claiming the ID was copied", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  menuPanel({
    sessionId: "session-id",
    onCopySessionId: vi.fn(async () => {
      throw new Error("clipboard unavailable");
    }),
  });
  fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("button", { name: "Session ID" }));
  expect(await screen.findByRole("status")).toHaveTextContent("复制失败，请重试。");
  expect(screen.queryByText("已复制")).toBeNull();
  expect(screen.queryByRole("button", { name: "重命名" })).toBeNull();
});
