import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsPreview } from "./SettingsPreview";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

test("automatic paste starts disabled and can be enabled manually", async () => {
  const { container } = render(<SettingsPreview initialTab="clipboard" />);
  const toggle = within(container).getByRole("switch", { name: "自动粘贴" });
  expect(toggle).not.toBeChecked();

  await userEvent.click(toggle);
  expect(toggle).toBeChecked();
});

test("CleanupInteraction", async () => {
  const { container: canvasElement } = render(<SettingsPreview initialTab="clipboard" />);
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "清理" }));
  await expect(canvas.getByRole("button", { name: "清理中..." })).toBeDisabled();
  await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("清理完成"));
  await expect(canvas.getByText("32.00 MB")).toBeVisible();
  await expect(canvas.getByRole("button", { name: "清理" })).toBeEnabled();
});

test("CleanupFailed", async () => {
  const { container: canvasElement } = render(
    <SettingsPreview initialTab="clipboard" cleanup="error" operationFailure />,
  );
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "清理" }));
  await waitFor(() => expect(canvas.getByRole("alert")).toHaveTextContent("清理失败，请重试"));
  await expect(canvas.getByText("128.00 MB")).toBeVisible();
  await expect(canvas.getByRole("button", { name: "清理" })).toBeEnabled();
});

test("RetentionControl", async () => {
  const { container: canvasElement } = render(<SettingsPreview initialTab="clipboard" />);
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "30 天" }));
  await userEvent.click(canvas.getByRole("button", { name: "永久" }));
  await expect(canvas.getByRole("button", { name: "永久" })).toBeVisible();
});

test("JumpToLocalModel", async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  const { container: canvasElement } = render(<SettingsPreview initialTab="clipboard" />);
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "去启用" }));
  await expect(canvas.getByRole("heading", { name: "模型" })).toBeVisible();
  await expect(canvas.getByRole("switch", { name: "启用本地模型" })).toBeVisible();
  expect(scrollIntoView).toHaveBeenCalled();
});
