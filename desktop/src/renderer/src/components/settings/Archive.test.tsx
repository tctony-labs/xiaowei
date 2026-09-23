import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { SettingsPreview } from "./SettingsPreview";

afterEach(cleanup);

test("SearchAndDelete", async () => {
  const { container: canvasElement } = render(<SettingsPreview initialTab="archive" />);
  const canvas = within(canvasElement);
  const page = within(document.body);
  fireEvent.change(canvas.getByPlaceholderText("搜索标题或工作区"), { target: { value: "XiaoWei" } });
  await expect(canvas.getByText("搜索与剪贴板交互讨论")).toBeVisible();
  await waitFor(() => expect(canvas.queryByText("整理本周的开发事项")).not.toBeInTheDocument());
  await userEvent.click(canvas.getByRole("button", { name: "删除" }));
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  await expect(canvas.getByText("搜索与剪贴板交互讨论")).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "删除" }));
  await userEvent.click(within(page.getByRole("dialog")).getByRole("button", { name: "删除" }));
  await expect(canvas.getByText("未找到匹配的会话")).toBeVisible();
});
