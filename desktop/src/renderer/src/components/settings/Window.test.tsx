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
  await userEvent.click(canvas.getByRole("button", { name: "快捷键" }));
  expect(canvas.getByText("快速对话")).toBeVisible();
});

test("Phase one preview keeps deferred UI in other stories but hides it from the product scope", async () => {
  const { container } = render(<SettingsPreview phaseOne development={false} />);
  const canvas = within(container);
  expect(canvas.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  for (const name of ["模型", "智能体", "对话归档"]) {
    expect(canvas.queryByRole("button", { name })).not.toBeInTheDocument();
  }
  await userEvent.click(canvas.getByRole("button", { name: "快捷键" }));
  expect(canvas.queryByText("快速对话")).not.toBeInTheDocument();
  await userEvent.click(canvas.getByRole("button", { name: "剪贴板" }));
  expect(canvas.queryByText("图片内容提取")).not.toBeInTheDocument();
  await userEvent.click(canvas.getByRole("button", { name: "关于" }));
  expect(canvas.queryByRole("button", { name: "检查更新" })).not.toBeInTheDocument();
});
