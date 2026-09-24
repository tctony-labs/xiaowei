import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import QuickChatTitleBar, { type QuickChatTitleBarProps } from "./QuickChatTitleBar";

afterEach(cleanup);

function setup(overrides: Partial<QuickChatTitleBarProps> = {}) {
  const props: QuickChatTitleBarProps = {
    convId: "quick-1",
    title: "当前对话",
    autoTitle: true,
    workspaceDir: "/Users/demo/.xiaowei/quick-chat/20260924-093000",
    grantedPaths: [],
    isGenerating: false,
    isRegeneratingTitle: false,
    hasAssistantReply: true,
    sessions: [{ id: "quick-2", title: "另一段对话" }],
    sessionsLoading: false,
    onListSessions: vi.fn(),
    onCreateSession: vi.fn(),
    onSwitchSession: vi.fn(),
    onRename: vi.fn(),
    onRegenerateTitle: vi.fn(async () => {}),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onCopyId: vi.fn(async () => {}),
    onOpenTitleModelSettings: vi.fn(),
    ...overrides,
  };
  const view = render(<QuickChatTitleBar {...props} />);
  return { props, ...view };
}

async function click(name: string) {
  await userEvent.click(screen.getByRole("button", { name }));
}

async function openRename() {
  await click("更多操作");
  await click("重命名");
  return screen.getByRole("textbox", { name: "对话标题" });
}

test("menus are exclusive, close on Escape or outside click, and load only when opened", async () => {
  const { props } = setup();
  await click("选择会话");
  expect(props.onListSessions).toHaveBeenCalledTimes(1);
  expect(screen.getByText("另一段对话")).toBeVisible();
  await click("更多操作");
  expect(screen.queryByText("另一段对话")).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByText("Session ID")).not.toBeInTheDocument();
  await click("更多操作");
  fireEvent.mouseDown(document.body);
  expect(screen.queryByText("Session ID")).not.toBeInTheDocument();
  await click("选择会话");
  await click("选择会话");
  expect(props.onListSessions).toHaveBeenCalledTimes(2);
  await click("选择会话");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByText("另一段对话")).not.toBeInTheDocument();
});

test("session actions pass the correct identifiers and close their menus", async () => {
  const { props } = setup();
  await click("选择会话");
  await click("另一段对话");
  expect(props.onSwitchSession).toHaveBeenCalledWith("quick-2");
  expect(screen.queryByText("另一段对话")).not.toBeInTheDocument();
  await click("更多操作");
  await click("Session ID");
  expect(props.onCopyId).toHaveBeenCalledWith("quick-1");
  expect(await screen.findByText("已复制")).toBeVisible();
  await click("更多操作");
  await click("归档");
  expect(props.onArchive).toHaveBeenCalledTimes(1);
  await click("新建对话");
  expect(props.onCreateSession).toHaveBeenCalledTimes(1);
});

test("rename selects text, trims on Enter, cancels on Escape and commits on blur", async () => {
  const { props } = setup();
  let input = (await openRename()) as HTMLInputElement;
  expect(input).toHaveFocus();
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
  fireEvent.change(input, { target: { value: "  新标题  " } });
  await userEvent.keyboard("{Enter}");
  expect(props.onRename).toHaveBeenCalledExactlyOnceWith("新标题");
  input = (await openRename()) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "取消修改" } });
  await userEvent.keyboard("{Escape}");
  expect(props.onRename).toHaveBeenCalledTimes(1);
  input = (await openRename()) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "失焦保存" } });
  fireEvent.blur(input);
  expect(props.onRename).toHaveBeenLastCalledWith("失焦保存");
});

test("rename ignores empty or unchanged titles and composition confirmation", async () => {
  const { props } = setup();
  let input = await openRename();
  fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
  expect(input).toHaveFocus();
  expect(props.onRename).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  input = await openRename();
  fireEvent.change(input, { target: { value: "   " } });
  await userEvent.keyboard("{Enter}");
  expect(props.onRename).not.toHaveBeenCalled();
});

test("delete requires confirmation and supports cancellation", async () => {
  const { props } = setup();
  await click("更多操作");
  await click("删除会话");
  expect(screen.getByRole("dialog", { name: "确认删除" })).toBeVisible();
  await click("取消");
  expect(props.onDelete).not.toHaveBeenCalled();
  await click("更多操作");
  await click("删除会话");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除" }));
  expect(props.onDelete).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("draft disables persisted-session operations", async () => {
  setup({ convId: null, hasAssistantReply: false });
  expect(screen.queryByRole("button", { name: "在对话窗口中打开" })).not.toBeInTheDocument();
  await click("更多操作");
  for (const name of ["Session ID", "重命名", "更新标题", "归档", "删除会话"]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
  }
  expect(screen.getByRole("button", { name: "新建对话" })).toBeEnabled();
});

test.each([{ hasAssistantReply: false }, { isGenerating: true }, { isRegeneratingTitle: true }])(
  "title generation is unavailable for %j",
  async (state) => {
    setup(state);
    await click("更多操作");
    const name = state.isRegeneratingTitle ? "正在生成标题..." : "更新标题";
    expect(screen.getByRole("button", { name })).toBeDisabled();
  },
);

test("title failure links to the model setting without opening a real settings window", async () => {
  const { props } = setup({
    onRegenerateTitle: vi.fn(async () => {
      throw new Error("尚未配置小文本任务模型，请先在设置中选择");
    }),
  });
  await click("更多操作");
  await click("更新标题");
  expect(await screen.findByText("尚未配置小文本任务模型，请先在设置中选择")).toBeVisible();
  await click("选择小文本任务模型");
  expect(props.onOpenTitleModelSettings).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("尚未配置小文本任务模型，请先在设置中选择")).not.toBeInTheDocument();
});

test("session loading and empty results are controlled by the adapter", async () => {
  const { props, rerender } = setup({ sessionsLoading: true });
  await click("选择会话");
  expect(screen.getByText("加载中...")).toBeVisible();
  await act(async () => rerender(<QuickChatTitleBar {...props} sessionsLoading={false} sessions={[]} />));
  expect(screen.getByText("暂无对话")).toBeVisible();
});
