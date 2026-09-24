import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { QuickChatLauncherPreview } from "./QuickChatLauncherPreview";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function viewport() {
  return screen.getByTestId("quick-chat-viewport");
}

function chatInput() {
  return screen.getByRole("textbox", { name: "快速对话输入" });
}

async function click(name: string) {
  await userEvent.click(screen.getByRole("button", { name }));
}

async function expand() {
  fireEvent.keyDown(screen.getByRole("textbox", { name: "搜索" }), { key: "ArrowDown" });
  expect(viewport()).toHaveAttribute("data-expanded", "true");
  expect(chatInput()).toHaveFocus();
}

async function expectCollapsed() {
  expect(viewport()).toHaveAttribute("data-expanded", "false");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "搜索" })).toHaveFocus());
}

test("empty search expands; Escape animates back before restoring search focus", async () => {
  render(<QuickChatLauncherPreview initialState="first-use" />);
  expect(viewport()).toHaveStyle({ height: "71px" });
  await expand();
  expect(viewport()).toHaveStyle({ height: "580px", transition: "height 300ms ease-out" });
  expect(screen.getByText("输入问题开始对话")).toBeVisible();
  fireEvent.keyDown(chatInput(), { key: "Escape" });
  expect(viewport()).toHaveAttribute("data-animating", "true");
  expect(chatInput()).toBeInTheDocument();
  await expectCollapsed();
  fireEvent.keyDown(screen.getByRole("textbox", { name: "搜索" }), { key: "Escape" });
  expect(screen.getByRole("button", { name: "重新打开搜索框" })).toBeVisible();
});

test("ArrowUp collapses only from an empty composer, not message area or nonempty input", async () => {
  render(<QuickChatLauncherPreview initiallyExpanded />);
  fireEvent.keyDown(screen.getByText("帮我整理一下本周要做的事情。"), { key: "ArrowUp" });
  expect(viewport()).toHaveAttribute("data-expanded", "true");
  fireEvent.change(chatInput(), { target: { value: "还没发送" } });
  fireEvent.keyDown(chatInput(), { key: "ArrowUp" });
  expect(viewport()).toHaveAttribute("data-expanded", "true");
  fireEvent.change(chatInput(), { target: { value: "   " } });
  fireEvent.keyDown(chatInput(), { key: "ArrowUp" });
  await expectCollapsed();
});

test("nonempty search keeps result navigation and composition never changes modes", async () => {
  render(<QuickChatLauncherPreview initialQuery="搜索" />);
  const search = screen.getByRole("textbox", { name: "搜索" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(screen.getByText("剪贴板搜索示例")).toHaveClass("bg-primary-bg");
  expect(viewport()).toHaveAttribute("data-expanded", "false");
  fireEvent.change(search, { target: { value: " " } });
  fireEvent.compositionStart(search);
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(viewport()).toHaveAttribute("data-expanded", "false");
  fireEvent.compositionEnd(search);
  await expand();
  for (const key of ["Escape", "ArrowUp"]) {
    fireEvent.keyDown(chatInput(), { key, isComposing: true, keyCode: 229 });
    expect(viewport()).toHaveAttribute("data-expanded", "true");
  }
});

test("menus, rename, model selection and delete dialog consume Escape first", async () => {
  render(<QuickChatLauncherPreview initiallyExpanded />);
  await click("更多操作");
  fireEvent.keyDown(chatInput(), { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Session ID" })).not.toBeInTheDocument();
  expect(viewport()).toHaveAttribute("data-expanded", "true");
  await click("更多操作");
  await click("重命名");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "对话标题" }), { key: "Escape" });
  expect(viewport()).toHaveAttribute("data-expanded", "true");
  await click("默认模型");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("button", { name: "推理模型" })).not.toBeInTheDocument();
  expect(viewport()).toHaveAttribute("data-expanded", "true");
  await click("更多操作");
  await click("删除会话");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(viewport()).toHaveAttribute("data-expanded", "true");
});

test.each(["first-use", "all-archived", "all-deleted"] as const)(
  "%s starts as a draft and first send creates a session",
  async (state) => {
    render(<QuickChatLauncherPreview initialState={state} initiallyExpanded />);
    expect(screen.getByText("输入问题开始对话")).toBeVisible();
    await click("更多操作");
    expect(screen.getByRole("button", { name: "重命名" })).toBeDisabled();
    fireEvent.keyDown(chatInput(), { key: "Escape" });
    fireEvent.change(chatInput(), { target: { value: "第一条消息" } });
    fireEvent.keyDown(chatInput(), { key: "Enter" });
    expect(screen.getByText("第一条消息")).toBeVisible();
    await click("更多操作");
    expect(screen.getByRole("button", { name: "重命名" })).toBeEnabled();
    fireEvent.keyDown(chatInput(), { key: "Escape" });
    expect(screen.getByRole("button", { name: "停止生成" })).toBeVisible();
    await click("停止生成");
    expect(screen.queryByText("正在思考...")).not.toBeInTheDocument();
  },
);

test.each(["归档", "删除会话"])("removing the last session through %s reaches the empty state", async (action) => {
  render(<QuickChatLauncherPreview initialState="last-session" initiallyExpanded />);
  await click("更多操作");
  await click(action);
  if (action === "删除会话") await click("删除");
  expect(screen.getByText("输入问题开始对话")).toBeVisible();
  await click("选择会话");
  expect(screen.getByText("暂无对话")).toBeVisible();
  fireEvent.keyDown(chatInput(), { key: "Escape" });
  fireEvent.keyDown(chatInput(), { key: "Escape" });
  await expectCollapsed();
  await expand();
  expect(screen.getByText("输入问题开始对话")).toBeVisible();
});

test("create and switch sessions preserve their mock messages", async () => {
  render(<QuickChatLauncherPreview initiallyExpanded />);
  await click("新建对话");
  expect(chatInput()).toHaveFocus();
  expect(screen.getByText("输入问题开始对话")).toBeVisible();
  await click("选择会话");
  await click("搜索与剪贴板交互讨论");
  expect(screen.getByText("看看搜索与剪贴板的键盘交互。")).toBeVisible();
  expect(chatInput()).toHaveFocus();
});

test("rapid reversal cancels the old collapse timer and retains the expanded composer", async () => {
  vi.useFakeTimers();
  render(<QuickChatLauncherPreview />);
  await expand();
  fireEvent.keyDown(chatInput(), { key: "ArrowUp" });
  act(() => vi.advanceTimersByTime(120));
  fireEvent.keyDown(chatInput(), { key: "ArrowDown" });
  act(() => vi.advanceTimersByTime(400));
  expect(viewport()).toHaveAttribute("data-expanded", "true");
  expect(viewport()).toHaveAttribute("data-animating", "false");
  expect(chatInput()).toHaveFocus();
});
