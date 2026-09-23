import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { SettingsPreview } from "./SettingsPreview";

afterEach(cleanup);

test("Navigate", async () => {
  const { container: canvasElement } = render(<SettingsPreview initialTab="general" />);
  const canvas = within(canvasElement);
  for (const name of ["快捷键", "剪贴板", "模型", "智能体", "对话归档", "关于", "通用"]) {
    await userEvent.click(canvas.getByRole("button", { name }));
    await expect(canvas.getByRole("heading", { name })).toBeVisible();
  }
  await expect(canvas.queryByRole("button", { name: "扩展" })).not.toBeInTheDocument();
});
