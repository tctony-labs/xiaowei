import { create, toBinary } from "@bufbuild/protobuf";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ClipboardBiz,
  ClipboardStorageUsageSchema,
  EmptySchema,
  ModelSettings,
  ModelSettingsChangedSchema,
  ModelSettingsSnapshotSchema,
  PurgeOrdinaryResponseSchema,
  Settings,
  SettingsAnchor,
  SettingsChangedSchema,
  SettingsNavigationRequestedSchema,
  SettingsSnapshotSchema,
  System,
  TakeSettingsNavigationResponseSchema,
  ThemeMode,
} from "xiaowei-contracts";
import { bindEvent, bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../../services";
import { SettingsPage } from "./SettingsPage";

afterEach(cleanup);

test("product settings loads saved values and sends changes and cleanup to services", async () => {
  const host = new GatewayHost();
  host.registerOwner(
    "system",
    bindHandlers(
      System,
      {
        takeSettingsNavigation: () => create(TakeSettingsNavigationResponseSchema),
      },
      { partial: true },
    ),
  );
  const updates = vi.fn();
  const purge = vi.fn(() => create(PurgeOrdinaryResponseSchema));
  let snapshot = create(SettingsSnapshotSchema, {
    theme: ThemeMode.SYSTEM,
    autostart: false,
    includeChromeBookmarks: true,
    clipboardEnabled: true,
    clipboardAutoPaste: true,
    clipboardRetentionDays: 30,
    shortcuts: {
      main: { keys: ["Meta", "Space"] },
      clipboard: { keys: ["Meta", "Shift", "KeyX"] },
      quickChat: { keys: ["Meta", "Shift", "KeyC"] },
    },
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
        if (request.change.case === "shortcuts") {
          snapshot = create(SettingsSnapshotSchema, { ...snapshot, shortcuts: request.change.value });
        }
        return snapshot;
      },
    }),
    [
      bindEvent(SettingsChangedSchema, EmptySchema, "coalesce", () => true),
      bindEvent(SettingsNavigationRequestedSchema, EmptySchema, "coalesce", () => true),
    ],
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

  await userEvent.click(screen.getByRole("button", { name: "快捷键" }));
  const chat = screen.getByRole("textbox", { name: "录制快速对话快捷键" });
  expect(chat).toHaveTextContent("C");

  await userEvent.click(chat);
  await userEvent.keyboard("{Meta>}[Space]{/Meta}{Enter}");
  await waitFor(() => expect(snapshot.shortcuts?.quickChat?.keys).toEqual(["Meta", "Space"]));
  expect(snapshot.shortcuts?.main).toBeUndefined();
  expect(snapshot.shortcuts?.clipboard?.keys).toEqual(["Meta", "Shift", "KeyX"]);
  expect(screen.getByRole("textbox", { name: "录制全局搜索快捷键" })).toHaveTextContent("录制全局搜索快捷键");

  const recorder = chat.parentElement;
  if (!recorder) throw new Error("Shortcut recorder container is missing");
  await userEvent.click(within(recorder).getByRole("button", { name: "清除" }));
  await waitFor(() => expect(snapshot.shortcuts?.quickChat).toBeUndefined());
  expect(chat).toHaveTextContent("录制快速对话快捷键");

  await userEvent.click(screen.getByRole("button", { name: "剪贴板" }));
  expect(await screen.findByText("2.00 KB")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "清理" }));
  await waitFor(() => expect(purge).toHaveBeenCalledOnce());

  await userEvent.click(screen.getByRole("button", { name: "关于" }));
  expect(screen.getByText("版本 0.1.0")).toBeVisible();
  expect(screen.queryByRole("button", { name: "检查更新" })).not.toBeInTheDocument();
});

test("navigation waits for models to load and repeated navigation restarts the highlight", async () => {
  const scroll = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  const host = new GatewayHost();
  let pending = true;
  host.registerOwner(
    "system",
    bindHandlers(
      System,
      {
        takeSettingsNavigation: () => {
          const anchor = pending ? SettingsAnchor.MODEL_PROVIDERS : SettingsAnchor.UNSPECIFIED;
          pending = false;
          return create(TakeSettingsNavigationResponseSchema, { anchor });
        },
      },
      { partial: true },
    ),
  );
  const owner = host.registerOwner(
    "settings",
    bindHandlers(Settings, {
      get: () => create(SettingsSnapshotSchema),
      update: () => create(SettingsSnapshotSchema),
    }),
    [
      bindEvent(SettingsChangedSchema, EmptySchema, "coalesce", () => true),
      bindEvent(SettingsNavigationRequestedSchema, EmptySchema, "coalesce", () => true),
    ],
  );
  let release: (() => void) | undefined;
  host.registerOwner(
    "models",
    bindHandlers(
      ModelSettings,
      {
        get: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return create(ModelSettingsSnapshotSchema);
        },
      },
      { partial: true },
    ),
    [bindEvent(ModelSettingsChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const services = createServices(() => host.client({ caller: "settings-test", trusted: true }));
  try {
    render(
      <StrictMode>
        <SettingsPage version="test" development services={services} />
      </StrictMode>,
    );
    const navigate = () => {
      pending = true;
      owner.publish(
        SettingsNavigationRequestedSchema.typeName,
        toBinary(SettingsNavigationRequestedSchema, create(SettingsNavigationRequestedSchema)),
      );
    };
    await waitFor(() => expect(release).toBeDefined());
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => release?.());
    const row = document.getElementById("settings-model-providers");
    expect(row).toHaveTextContent("模型提供商");
    expect(row).not.toHaveTextContent("默认模型");
    await waitFor(() => expect(row).toHaveClass("ring-primary/60"));
    expect(scroll).toHaveBeenCalledOnce();
    await waitFor(() => expect(row).not.toHaveClass("ring-primary/60"), { timeout: 2500 });
    act(navigate);
    await waitFor(() => expect(row).toHaveClass("ring-primary/60"));
    expect(scroll).toHaveBeenCalledTimes(2);
  } finally {
    cleanup();
    HTMLElement.prototype.scrollIntoView = original;
    owner.close();
  }
});
