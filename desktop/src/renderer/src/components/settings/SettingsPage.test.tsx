import { create } from "@bufbuild/protobuf";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import {
  ClipboardBiz,
  ClipboardStorageUsageSchema,
  EmptySchema,
  PurgeOrdinaryResponseSchema,
  Settings,
  SettingsChangedSchema,
  SettingsSnapshotSchema,
  ThemeMode,
} from "xiaowei-contracts";
import { bindEvent, bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../../services";
import { SettingsPage } from "./SettingsPage";

afterEach(cleanup);

test("product settings loads saved values and sends changes and cleanup to services", async () => {
  const host = new GatewayHost();
  const updates = vi.fn();
  const purge = vi.fn(() => create(PurgeOrdinaryResponseSchema));
  let snapshot = create(SettingsSnapshotSchema, {
    theme: ThemeMode.SYSTEM,
    autostart: false,
    includeChromeBookmarks: true,
    clipboardEnabled: true,
    clipboardAutoPaste: true,
    clipboardRetentionDays: 30,
  });

  host.registerOwner(
    "settings-test",
    bindHandlers(Settings, {
      get: () => snapshot,
      update(request) {
        updates(request.change);
        if (request.change.case === "includeChromeBookmarks") {
          snapshot = create(SettingsSnapshotSchema, {
            ...snapshot,
            includeChromeBookmarks: request.change.value,
          });
        }
        return snapshot;
      },
    }),
    [bindEvent(SettingsChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  host.registerOwner(
    "clipboard-test",
    bindHandlers(
      ClipboardBiz,
      {
        storageUsage: () => create(ClipboardStorageUsageSchema, { usedBytes: 2048n }),
        purgeOrdinary: purge,
      },
      { partial: true },
    ),
  );
  const services = createServices(() => host.client({ caller: "settings-page-test", trusted: true }));
  render(<SettingsPage version="0.1.0" development={true} services={services} />);

  const bookmarks = await screen.findByRole("switch", { name: "全局搜索包含Chrome书签" });
  await userEvent.click(bookmarks);
  await waitFor(() => expect(updates).toHaveBeenCalledWith({ case: "includeChromeBookmarks", value: false }));

  await userEvent.click(screen.getByRole("button", { name: "剪贴板" }));
  expect(await screen.findByText("2.00 KB")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "清理" }));
  await waitFor(() => expect(purge).toHaveBeenCalledOnce());

  await userEvent.click(screen.getByRole("button", { name: "关于" }));
  expect(screen.getByText("版本 0.1.0")).toBeVisible();
  expect(screen.queryByRole("button", { name: "检查更新" })).not.toBeInTheDocument();
});
