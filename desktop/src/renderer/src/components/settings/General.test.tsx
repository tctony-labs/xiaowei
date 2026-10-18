import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { SettingsPreview } from "./SettingsPreview";

afterEach(cleanup);

test("general settings controls remain interactive", async () => {
  const { container: canvasElement } = render(<SettingsPreview initialTab="general" />);
  const canvas = within(canvasElement);
  const toggle = canvas.getByRole("switch", { name: "开机自启动" });
  await userEvent.click(toggle);
  await expect(toggle).toHaveAttribute("aria-checked", "true");
});
