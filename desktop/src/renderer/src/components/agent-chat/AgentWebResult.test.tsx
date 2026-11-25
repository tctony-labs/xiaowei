import { create } from "@bufbuild/protobuf";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AgentToolCallSchema, AgentToolStatus } from "proto-desktop-ts";
import { afterEach, expect, test, vi } from "vitest";
import { AgentMessage } from "./AgentMessage";
import { AgentWebResult } from "./AgentWebResult";

afterEach(cleanup);

function call(metadataJson?: string) {
  return create(AgentToolCallSchema, {
    toolId: "search",
    name: "WebSearch",
    status: AgentToolStatus.COMPLETED,
    argumentsJson: '{"query":"fixture"}',
    output: "fallback output",
    metadataJson,
  });
}

test("ordered, scrollable results open safe URLs", async () => {
  const onOpenUrl = vi.fn(async () => {});
  const snippet = "summary one ".repeat(80).trimEnd();
  render(
    <AgentWebResult
      call={call(
        JSON.stringify({
          webSearch: {
            query: "metadata query",
            provider: "bing",
            results: [
              { title: "First", url: "https://example.com/page", snippet },
              { title: "Second", url: "javascript:alert(1)", snippet: "summary two" },
            ],
          },
        }),
      )}
      onOpenUrl={onOpenUrl}
    />,
  );
  const parameters = screen.getByRole("region", { name: "网页工具参数" });
  const results = screen.getByRole("region", { name: "搜索结果" });
  expect(parameters).toHaveTextContent("fixture");
  expect(parameters).toHaveClass("agent-tool-scroll");
  expect(parameters.nextElementSibling).toBe(results);
  const items = within(results).getAllByRole("listitem");
  expect(results).toHaveClass("agent-tool-scroll");
  expect(results).toHaveAttribute("tabindex", "0");
  expect(items[0]).toHaveTextContent(`Firstexample.com${snippet}`);
  expect(items[1]).toHaveTextContent("Secondsummary two");
  expect(screen.queryByRole("link", { name: "Second" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "First" }));
  expect(onOpenUrl).toHaveBeenCalledWith("https://example.com/page");
  expect(screen.queryByRole("button", { name: "复制工具结果" })).toBeNull();
});

test("search metadata supplies the query when stored arguments omit it", () => {
  const search = call(
    JSON.stringify({
      webSearch: {
        query: "stored query",
        results: [{ title: "First", url: "https://example.com/page", snippet: "summary" }],
      },
    }),
  );
  render(<AgentWebResult call={{ ...search, argumentsJson: "{}" }} />);
  expect(screen.getByRole("region", { name: "网页工具参数" })).toHaveTextContent("stored query");
  expect(screen.getByRole("region", { name: "搜索结果" })).toHaveTextContent("First");
});

test("invalid metadata, empty results and failures retain readable output", () => {
  const { rerender } = render(<AgentWebResult call={call("invalid")} />);
  expect(screen.getByText("fallback output")).toBeVisible();
  rerender(<AgentWebResult call={call('{"webSearch":{"query":"q","results":[null]}}')} />);
  expect(screen.getByText("fallback output")).toBeVisible();
  rerender(<AgentWebResult call={call('{"webSearch":{"query":"q","results":[]}}')} />);
  expect(screen.getByText("fallback output")).toBeVisible();
  rerender(
    <AgentWebResult call={{ ...call(), status: AgentToolStatus.FAILED, output: "HTTP 401" }} />,
  );
  expect(screen.getByText("HTTP 401")).toBeVisible();
});

test("fetch shows its URL, extraction instruction and output; unsafe schemes have no link", () => {
  const prompt = "Read details ".repeat(80).trimEnd();
  render(
    <AgentWebResult
      call={{
        ...call(),
        name: "WebFetch",
        argumentsJson: JSON.stringify({ url: "file:///etc/passwd", prompt }),
      }}
      onOpenUrl={vi.fn()}
    />,
  );
  const parameters = screen.getByRole("region", { name: "网页工具参数" });
  const instruction = screen.getByRole("region", { name: "提取指令" });
  const output = screen.getByRole("region", { name: "网页工具输出" });
  expect(parameters).toHaveClass("agent-content-scroll");
  expect(parameters).toHaveAttribute("tabindex", "0");
  expect(parameters).toHaveTextContent("file:///etc/passwd");
  expect(instruction).toHaveClass("agent-tool-scroll");
  expect(instruction).toHaveAttribute("tabindex", "0");
  expect(instruction).toHaveTextContent(prompt);
  expect(parameters.nextElementSibling).toBe(instruction);
  expect(instruction.nextElementSibling).toBe(output);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

test("fallback queries and raw parameters scroll separately from tool output", () => {
  const query = "long search query ".repeat(100).trimEnd();
  const search = call();
  const { rerender } = render(
    <AgentWebResult call={{ ...search, argumentsJson: JSON.stringify({ query }) }} />,
  );
  const parameters = screen.getByRole("region", { name: "网页工具参数" });
  const output = screen.getByRole("region", { name: "网页工具输出" });
  expect(parameters).toHaveClass("agent-tool-scroll");
  expect(parameters).toHaveAttribute("tabindex", "0");
  expect(parameters).toHaveTextContent(query);
  expect(output).toHaveClass("agent-tool-scroll");
  expect(parameters).not.toContainElement(output);

  const argumentsJson = JSON.stringify(["x".repeat(1000)]);
  rerender(<AgentWebResult call={{ ...search, argumentsJson }} />);
  expect(parameters).toHaveTextContent(argumentsJson);
  expect(output).toHaveTextContent("fallback output");
});

test("grouped web tools open links and omit the tool copy action", () => {
  const onOpenUrl = vi.fn(async () => {});
  render(
    <AgentMessage
      message={{
        id: "message",
        role: "assistant",
        status: "complete",
        blocks: [
          {
            id: "fetch",
            kind: "tool",
            call: {
              ...call(),
              name: "WebFetch",
              argumentsJson: '{"url":"https://example.com/","prompt":"Read"}',
            },
          },
          { id: "search", kind: "tool", call: call() },
        ],
      }}
      onOpenUrl={onOpenUrl}
      onCopy={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "展开过程组" }));
  fireEvent.click(screen.getByLabelText("读取网页 https://example.com/ · 已完成"));
  fireEvent.click(screen.getByRole("link"));
  expect(onOpenUrl).toHaveBeenCalledWith("https://example.com/");
  fireEvent.click(screen.getByLabelText("搜索网络 fixture · 已完成"));
  expect(screen.getAllByText("fallback output")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "复制工具结果" })).toBeNull();
});
