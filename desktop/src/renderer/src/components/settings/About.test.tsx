import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { SettingsPreview } from "./SettingsPreview";

afterEach(cleanup);

test("CheckUpdate", async () => {
  const { container: canvasElement } = render(<SettingsPreview initialTab="about" />);
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "检查更新" }));
  await expect(canvas.getByRole("status")).toHaveTextContent("检查更新（预览）");
});
