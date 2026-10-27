import { create } from "@bufbuild/protobuf";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

test("ordered results open safe URLs and copy the original output through callbacks", async () => {
  const onOpenUrl = vi.fn(async () => {});
  const onCopy = vi.fn(async () => {});
  render(
    <AgentWebResult
      call={call(
        JSON.stringify({
          webSearch: {
            query: "fixture",
            provider: "bing",
            results: [
              { title: "First", url: "https://example.com/page", snippet: "summary one" },
              { title: "Second", url: "javascript:alert(1)", snippet: "summary two" },
            ],
          },
        }),
      )}
      onOpenUrl={onOpenUrl}
      onCopy={onCopy}
    />,
  );
  expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Firstexample.comsummary one");
  expect(screen.queryByRole("link", { name: "Second" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "First" }));
  expect(onOpenUrl).toHaveBeenCalledWith("https://example.com/page");
  fireEvent.click(screen.getByRole("button", { name: "复制工具结果" }));
  await waitFor(() => expect(onCopy).toHaveBeenCalledWith("fallback output"));
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
  render(
    <AgentWebResult
      call={{
        ...call(),
        name: "WebFetch",
        argumentsJson: '{"url":"file:///etc/passwd","prompt":"Read details"}',
      }}
      onOpenUrl={vi.fn()}
    />,
  );
  expect(screen.getByText("Read details")).toBeVisible();
  expect(screen.getByText("file:///etc/passwd")).toBeVisible();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

test("message and grouped calls pass URL and copy actions to web result cards", async () => {
  const onOpenUrl = vi.fn(async () => {});
  const onCopy = vi.fn(async () => {});
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
      onCopy={onCopy}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "展开工具调用" }));
  fireEvent.click(screen.getByLabelText("读取网页 https://example.com/ · 已完成"));
  fireEvent.click(screen.getByRole("link"));
  expect(onOpenUrl).toHaveBeenCalledWith("https://example.com/");
  const details = screen.getByRole("link").closest("details");
  if (!details) throw new Error("missing fetch tool details");
  fireEvent.click(within(details).getByRole("button", { name: "复制工具结果" }));
  await waitFor(() => expect(onCopy).toHaveBeenCalledWith("fallback output"));
});
