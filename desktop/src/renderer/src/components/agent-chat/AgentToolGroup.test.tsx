import { create } from "@bufbuild/protobuf";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentToolCallSchema, AgentToolStatus } from "proto-desktop-ts";
import { afterEach, expect, test } from "vitest";
import { AgentToolGroup } from "./AgentToolGroup";
import type { AgentToolBlock } from "./message-blocks";

afterEach(cleanup);

function tool(
  id: string,
  name: string,
  status = AgentToolStatus.COMPLETED,
  argumentsJson = "{}",
): AgentToolBlock {
  return {
    id,
    kind: "tool",
    call: create(AgentToolCallSchema, { toolId: id, name, status, argumentsJson }),
  };
}

test("collapsed consecutive reads describe the activity without a call count", () => {
  render(<AgentToolGroup blocks={[tool("read-1", "Read"), tool("read-2", "Read")]} />);
  const toggle = screen.getByRole("button", { name: "展开工具调用" });
  expect(toggle).toHaveTextContent("读取文件");
  expect(toggle).not.toHaveTextContent(/工具调用|Read|\d/);
  expect(toggle).toHaveAttribute("aria-busy", "false");
});

test("an active group shows its current action, then summarizes without losing expansion", () => {
  const first = tool("read-1", "Read");
  const second = tool(
    "read-2",
    "Read",
    AgentToolStatus.PENDING,
    '{"path":"/workspace/retries.json"}',
  );
  const { rerender } = render(<AgentToolGroup blocks={[first, second]} />);
  const toggle = screen.getByRole("button", { name: "展开工具调用" });
  expect(toggle).toHaveTextContent("读取 retries.json");
  expect(toggle).not.toHaveTextContent(/工具调用|Read|已完成/);
  expect(toggle).toHaveAttribute("aria-busy", "true");
  expect(toggle.querySelector(".agent-shimmer")).not.toBeNull();
  fireEvent.click(toggle);
  fireEvent.click(screen.getByLabelText("读取 retries.json · 执行中"));
  const details = screen.getByLabelText("读取 retries.json · 执行中").closest("details");

  rerender(
    <AgentToolGroup
      blocks={[first, { ...second, call: { ...second.call, status: AgentToolStatus.COMPLETED } }]}
    />,
  );
  expect(screen.getByRole("button", { name: "收起工具调用" })).toBe(toggle);
  expect(toggle).toHaveTextContent("读取文件");
  expect(toggle).toHaveAttribute("aria-busy", "false");
  expect(toggle.querySelector(".agent-shimmer")).toBeNull();
  expect(details).toBeVisible();
  expect(details).toHaveAttribute("open");
  fireEvent.click(toggle);
  expect(toggle).toHaveTextContent("读取文件");
});

test("mixed calls summarize distinct actions while preserving the individual calls", () => {
  render(
    <AgentToolGroup
      blocks={[
        tool("glob", "Glob"),
        tool("grep-1", "Grep"),
        tool("grep-2", "Grep"),
        tool("read", "Read"),
        tool("bash", "Bash"),
      ]}
    />,
  );
  const toggle = screen.getByRole("button", { name: "展开工具调用" });
  expect(toggle).toHaveTextContent("读取文件、执行命令");
  expect(toggle.querySelector(".agent-tool-icon")).toHaveAttribute("data-icon", "file");
  fireEvent.click(toggle);
  expect(screen.getAllByLabelText("搜索内容 · 已完成")).toHaveLength(2);
});

test("file changes share a category and summary order is independent of call order", () => {
  const { rerender } = render(
    <AgentToolGroup
      blocks={[
        tool("bash", "Bash"),
        tool("read", "Read"),
        tool("write", "Write"),
        tool("edit", "Edit"),
      ]}
    />,
  );
  const toggle = screen.getByRole("button", { name: "展开工具调用" });
  expect(toggle).toHaveTextContent("修改文件、读取文件、执行命令");
  expect(toggle.querySelector(".agent-tool-icon")).toHaveAttribute("data-icon", "edit");

  rerender(<AgentToolGroup blocks={[tool("glob", "Glob"), tool("grep", "Grep")]} />);
  expect(toggle).toHaveTextContent("读取文件");
  expect(toggle).not.toHaveTextContent(/查找|搜索|\d/);
});

test("active command titles include the command rather than the tool name", () => {
  render(
    <AgentToolGroup
      blocks={[
        tool("read", "Read"),
        tool("bash", "Bash", AgentToolStatus.PENDING, '{"command":"pnpm check"}'),
      ]}
    />,
  );
  expect(screen.getByRole("button", { name: "展开工具调用" })).toHaveTextContent("执行 pnpm check");
});

test("invalid active arguments fall back to the action and group errors stay visible", () => {
  render(
    <AgentToolGroup
      blocks={[
        tool("failed-read", "Read", AgentToolStatus.FAILED),
        tool("active-read", "Read", AgentToolStatus.PENDING, "{invalid"),
      ]}
    />,
  );
  const toggle = screen.getByRole("button", { name: "展开工具调用" });
  expect(toggle).toHaveTextContent("读取文件");
  expect(toggle).toHaveTextContent("1 项异常");
});
