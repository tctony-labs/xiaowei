import { create } from "@bufbuild/protobuf";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  AgentInteractionAnswerSchema,
  AgentInteractionSchema,
  AgentInteractionStatus,
} from "proto-desktop-ts";
import { afterEach, expect, test, vi } from "vitest";
import { AgentInteraction } from "./AgentInteraction";
import type { InteractionControls, InteractionForm } from "./message-blocks";

afterEach(cleanup);

test("identical choices retain their indices and a single choice submits immediately", () => {
  const form: InteractionForm = {
    text: "",
    selectedIndices: [],
    submitting: false,
    uncertain: false,
    error: "",
  };
  const respond = vi.fn(() => expect(form.selectedIndices).toEqual([1]));
  const controls: InteractionControls = {
    form: () => form,
    onTextChange: () => {},
    onSelectionChange: (_id, indices) => {
      form.selectedIndices = indices;
    },
    onRespond: respond,
  };
  const view = create(AgentInteractionSchema, {
    interactionId: "question",
    revision: 1n,
    status: AgentInteractionStatus.PENDING,
    request: { case: "question", value: { question: "选择", options: ["同名", "同名"] } },
  });
  render(<AgentInteraction view={view} controls={controls} />);
  fireEvent.click(screen.getAllByRole("button", { name: "同名" })[1]);
  expect(respond).toHaveBeenCalledWith("question");
});

test("uncertain approvals disable alternatives and retry the original decision", () => {
  const respond = vi.fn();
  const reason = "写文件的原因。".repeat(100);
  render(
    <AgentInteraction
      view={create(AgentInteractionSchema, {
        interactionId: "permission",
        revision: 1n,
        status: AgentInteractionStatus.PENDING,
        request: { case: "permission", value: { path: "/a/file", reason } },
      })}
      controls={{
        form: () => ({
          text: "",
          selectedIndices: [],
          submitting: false,
          uncertain: true,
          error: "回应结果未确认",
        }),
        onTextChange: () => {},
        onSelectionChange: () => {},
        onRespond: respond,
      }}
    />,
  );
  const content = screen.getByRole("region", { name: "权限内容" });
  const approve = screen.getByRole("button", { name: "批准" });
  const deny = screen.getByRole("button", { name: "拒绝" });
  const retry = screen.getByRole("button", { name: "重试提交" });
  expect(content).toHaveClass("agent-content-scroll");
  expect(content).toHaveAttribute("tabindex", "0");
  expect(content).toHaveTextContent("/a/file");
  expect(content).toHaveTextContent(reason);
  expect(approve).toBeDisabled();
  expect(deny).toBeDisabled();
  for (const control of [approve, deny, retry, screen.getByRole("alert")]) {
    expect(content).not.toContainElement(control);
  }
  fireEvent.click(retry);
  expect(respond).toHaveBeenCalledExactlyOnceWith("permission");
});

test("questions and resolved answers scroll independently of the response controls", () => {
  const question = "进一步说明要求。".repeat(100);
  const text = "这是完整的回答。".repeat(100);
  const view = create(AgentInteractionSchema, {
    status: AgentInteractionStatus.PENDING,
    request: { case: "question", value: { question, options: ["接受", "拒绝"] } },
  });
  const { rerender } = render(<AgentInteraction view={view} />);
  const content = screen.getByRole("region", { name: "问题内容" });
  expect(content).toHaveClass("agent-content-scroll");
  expect(content).toHaveAttribute("tabindex", "0");
  expect(content).toHaveTextContent(question);
  expect(content).toContainElement(screen.getByRole("group", { name: "回答选项" }));
  expect(content).not.toContainElement(screen.getByRole("textbox", { name: "补充回答" }));
  expect(content).not.toContainElement(screen.getByRole("button", { name: "提交回答" }));

  rerender(
    <AgentInteraction
      view={{
        ...view,
        status: AgentInteractionStatus.RESOLVED,
        answer: create(AgentInteractionAnswerSchema, {
          answer: { case: "question", value: { text } },
        }),
      }}
    />,
  );
  fireEvent.click(screen.getByText("向你提问"));
  expect(screen.getByRole("region", { name: "问题内容" })).toHaveTextContent(text);
});
