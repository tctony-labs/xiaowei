import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { SettingsPreview } from "./SettingsPreview";

afterEach(cleanup);

test("TestFailure", async () => {
  const { container: canvasElement } = render(<SettingsPreview initialTab="agent" operationFailure />);
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "测试" }));
  await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("操作失败"));
});

test("KeyFailure", async () => {
  render(<SettingsPreview initialTab="agent" initialSearchEditor="tavily" operationFailure />);
  const page = within(document.body);
  fireEvent.change(page.getByLabelText("API Key"), { target: { value: "storybook-placeholder" } });
  await waitFor(() => expect(page.getByLabelText("API Key")).toHaveValue("storybook-placeholder"));
  await waitFor(() => expect(page.getByRole("button", { name: "保存" })).toBeEnabled());
  await userEvent.click(page.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(page.getByRole("alert")).toHaveTextContent("操作失败"));
});

test("DeleteKey", async () => {
  render(<SettingsPreview initialTab="agent" searchConfigured initialSearchEditor="tavily" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "删除 Key" }));
  await expect(page.getByRole("dialog", { name: "删除 API Key" })).toHaveTextContent("自动切回 Bing");
});

test("DeleteAndFallback", async () => {
  render(<SettingsPreview initialTab="agent" searchConfigured initialSearchEditor="tavily" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "删除 Key" }));
  await userEvent.click(page.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  await expect(page.getByRole("button", { name: "Bing" })).toBeVisible();
  await expect(page.getByRole("button", { name: "配置 Tavily" })).toBeVisible();
});
