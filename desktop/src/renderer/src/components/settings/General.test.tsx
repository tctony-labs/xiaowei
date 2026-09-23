import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { SettingsPreview } from "./SettingsPreview";

afterEach(cleanup);

test("AccountAndControls", async () => {
  const { container: canvasElement } = render(<SettingsPreview initialTab="general" />);
  const canvas = within(canvasElement);
  const toggle = canvas.getByRole("switch", { name: "开机自启动" });
  await userEvent.click(toggle);
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await userEvent.click(canvas.getByRole("button", { name: "退出登录" }));
  await expect(canvas.getByText("未登录")).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "登录" }));
  await waitFor(() => expect(canvas.getByRole("button", { name: "退出登录" })).toBeVisible());
});
