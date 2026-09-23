import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { SettingsPreview } from "./SettingsPreview";

afterEach(cleanup);

test("Recording", async () => {
  const { container: canvasElement } = render(<SettingsPreview initialTab="shortcut" />);
  const recorder = within(canvasElement).getByRole("textbox", { name: "录制全局搜索快捷键" });
  await userEvent.click(recorder);
  expect(recorder).toHaveFocus();
  expect(recorder).toHaveTextContent("请按下快捷键");
});

test("DuplicateAndCancel", async () => {
  const { container: canvasElement } = render(<SettingsPreview initialTab="shortcut" />);
  const canvas = within(canvasElement);
  const search = canvas.getByRole("textbox", { name: "录制全局搜索快捷键" });
  const clipboard = canvas.getByRole("textbox", { name: "录制剪贴板快捷键" });
  await userEvent.click(clipboard);
  await userEvent.keyboard("{Meta>}[Space]{/Meta}{Enter}");
  await expect(search).toHaveTextContent("录制全局搜索快捷键");
  await expect(clipboard).toHaveTextContent("Space");
  await userEvent.click(clipboard);
  await userEvent.keyboard("{Escape}");
  await expect(clipboard).toHaveTextContent("Space");
});
