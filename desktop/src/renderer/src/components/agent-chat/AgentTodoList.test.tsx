import { create } from "@bufbuild/protobuf";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AgentToolCallSchema, AgentToolStatus } from "proto-desktop-ts";
import { afterEach, expect, test, vi } from "vitest";
import { AgentMessage } from "./AgentMessage";
import { AgentToolCall } from "./AgentToolCall";
import type { AgentMessageBlock } from "./message-blocks";

afterEach(cleanup);

const todos = [
  { id: "a", content: "实现工具", status: "in_progress" },
  { id: "b", content: "验证恢复", status: "pending" },
  { id: "c", content: "完成的任务", status: "completed" },
  { id: "d", content: "取消的任务", status: "cancelled" },
];

function todo(id: string, list = todos): AgentMessageBlock {
  return {
    id,
    kind: "tool",
    call: create(AgentToolCallSchema, {
      name: "TodoWrite",
      toolId: id,
      status: AgentToolStatus.COMPLETED,
      argumentsJson: JSON.stringify({ merge: true, todos: [list[0]] }),
      metadataJson: JSON.stringify({ todoWrite: { todos: list } }),
    }),
  };
}

test("the completed card renders the full result rather than the merge arguments", () => {
  const block = todo("todo");
  if (block.kind !== "tool") throw new Error("expected tool");
  render(<AgentToolCall call={block.call} defaultOpen />);
  const list = screen.getByRole("list", { name: "待办清单" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(4);
  for (const status of ["待办", "进行中", "完成", "取消"]) {
    expect(within(list).getByRole("img", { name: status })).toBeVisible();
  }
  expect(screen.getByText("取消的任务").closest("li")).toHaveAttribute("data-status", "cancelled");
  expect(screen.queryByText("参数")).toBeNull();
});

test("todo cards split tool groups and only the latest defaults to expanded", () => {
  const read: AgentMessageBlock = {
    id: "read",
    kind: "tool",
    call: create(AgentToolCallSchema, { name: "Read", status: AgentToolStatus.COMPLETED }),
  };
  const props = { onCopy: vi.fn(async () => {}), onOpenUrl: vi.fn(async () => {}) };
  const message = {
    id: "run",
    role: "assistant" as const,
    status: "generating" as const,
    blocks: [read, todo("older"), { ...read, id: "read-2" }, todo("latest")],
  };
  const { rerender } = render(<AgentMessage {...props} message={message} />);
  const cards = screen.getAllByLabelText("更新待办 · 已完成");
  expect(cards[0].closest("details")).not.toHaveAttribute("open");
  expect(cards[1].closest("details")).toHaveAttribute("open");
  for (const card of cards) expect(card.closest(".agent-tool-group")).toBeNull();

  fireEvent.click(cards[1]);
  rerender(<AgentMessage {...props} message={{ ...message }} />);
  expect(cards[1].closest("details")).not.toHaveAttribute("open");
  rerender(
    <AgentMessage {...props} message={{ ...message, blocks: [...message.blocks, todo("new")] }} />,
  );
  const updated = screen.getAllByLabelText("更新待办 · 已完成");
  expect(updated[1].closest("details")).not.toHaveAttribute("open");
  expect(updated[2].closest("details")).toHaveAttribute("open");
});

test("empty snapshots are explicit; failed or malformed results show the original output", () => {
  const block = todo("empty", []);
  if (block.kind !== "tool") throw new Error("expected tool");
  const { rerender } = render(<AgentToolCall call={block.call} defaultOpen />);
  expect(screen.getByText("（空列表）")).toBeVisible();

  rerender(
    <AgentToolCall
      defaultOpen
      call={{ ...block.call, status: AgentToolStatus.FAILED, output: "todos 参数无效" }}
    />,
  );
  expect(screen.getByText("todos 参数无效")).toBeVisible();
  expect(screen.queryByText("（空列表）")).toBeNull();
  rerender(
    <AgentToolCall
      defaultOpen
      call={{
        ...block.call,
        metadataJson: '{"todoWrite":{"todos":[{"id":"invalid","status":"done"}]}}',
        output: "原始结果",
      }}
    />,
  );
  expect(screen.getByText("原始结果")).toBeVisible();
  expect(screen.queryByRole("list", { name: "待办清单" })).toBeNull();
});
