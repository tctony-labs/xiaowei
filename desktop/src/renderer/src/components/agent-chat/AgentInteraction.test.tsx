import { create } from "@bufbuild/protobuf";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentInteractionSchema, AgentInteractionStatus } from "proto-desktop-ts";
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
  render(
    <AgentInteraction
      view={create(AgentInteractionSchema, {
        interactionId: "permission",
        revision: 1n,
        status: AgentInteractionStatus.PENDING,
        request: { case: "permission", value: { path: "/a/file", reason: "写文件" } },
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
  expect(screen.getByRole("button", { name: "批准" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "重试提交" }));
  expect(respond).toHaveBeenCalledExactlyOnceWith("permission");
});
