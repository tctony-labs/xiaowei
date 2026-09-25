import { create } from "@bufbuild/protobuf";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import {
  ClipboardBiz,
  ClipboardCategoriesSchema,
  ClipboardChangedSchema,
  ClipboardItemsSchema,
  EmptySchema,
  ExecuteResponseSchema,
  FinishReason,
  GenerateEventSchema,
  LauncherMode,
  LauncherOpenedSchema,
  LauncherSearchResponseSchema,
  Launcher as LauncherService,
  Llm,
  ModelSettings,
  ModelSettingsChangedSchema,
  ModelSettingsSnapshotSchema,
} from "xiaowei-contracts";
import { bindEvent, bindHandlers, bindStreamHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../services";
import { Launcher } from "./Launcher";

function preview(clipboardMode = false) {
  const host = new GatewayHost();
  const calls = { execute: vi.fn(), resize: vi.fn(), hide: vi.fn() };
  host.registerOwner(
    "launcher",
    bindHandlers(LauncherService, {
      query: ({ query: value }) =>
        create(LauncherSearchResponseSchema, {
          token: clipboardMode ? 2 : 1,
          hits: !value
            ? []
            : clipboardMode
              ? [{ id: "command:clipboard", title: "剪贴板", provider: "command", label: "命令" }]
              : [
                  { id: "one", title: "微信", provider: "app", label: "应用", score: 100 },
                  { id: "two", title: "微信文档", provider: "bookmark", label: "网页", score: 90 },
                ],
        }),
      execute(request) {
        calls.execute(request);
        return create(ExecuteResponseSchema, { mode: clipboardMode ? LauncherMode.CLIPBOARD : undefined });
      },
      updateLayout(request) {
        calls.resize(request);
        return create(EmptySchema);
      },
      hide() {
        calls.hide();
        return create(EmptySchema);
      },
      resetPosition: () => create(EmptySchema),
    }),
    [{ name: LauncherOpenedSchema.typeName, policy: "coalesce", validate() {}, matches: () => true }],
  );

  host.registerOwner(
    "model-settings",
    bindHandlers(
      ModelSettings,
      {
        get: () =>
          create(ModelSettingsSnapshotSchema, {
            defaults: { modelRef: "default-model" },
            providers: [{ id: "provider", models: [{ id: "default-model" }] }],
          }),
      },
      { partial: true },
    ),
    [bindEvent(ModelSettingsChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  host.registerOwner(
    "llm",
    bindStreamHandlers(Llm, {
      async *generate() {
        yield create(GenerateEventSchema, {
          event: {
            case: "finished",
            value: {
              reason: FinishReason.STOP,
              message: { content: [{ content: { case: "text", value: { text: "Hello from LLM" } } }] },
            },
          },
        });
      },
      async *modelCatalog() {},
    }),
  );

  let subscribed = false;

  const unused = () => {
    throw new Error("Unused preview route");
  };
  host.registerOwner(
    "clipboard",
    bindHandlers(ClipboardBiz, {
      list: () => create(ClipboardItemsSchema),
      categories: () => {
        if (!subscribed) throw new Error("Snapshot requested before subscription ready");
        return create(ClipboardCategoriesSchema);
      },
      get: unused,
      readText: unused,
      readImage: unused,
      copy: unused,
      select: unused,
      delete: unused,
      setFavorite: unused,
      clearHistory: unused,
      purgeOrdinary: unused,
      purgeExpired: unused,
      storageUsage: unused,
      saveCategory: unused,
      deleteCategory: unused,
      setRemark: unused,
      editText: unused,
      setCategory: unused,
      openResource: unused,
      revealResource: unused,
      copyResourcePath: unused,
    }),
    [
      {
        name: ClipboardChangedSchema.typeName,
        policy: "coalesce",
        async attach() {
          await new Promise((resolve) => setTimeout(resolve, 50));
          subscribed = true;
          return { close() {} };
        },
      },
    ],
  );

  return { calls, services: createServices(() => host.client({ caller: "test", trusted: true })) };
}

afterEach(cleanup);

test("keyboard selection and composition guard", async () => {
  const search = preview();
  const canvas = render(<Launcher services={search.services} />);
  const user = userEvent.setup();
  const input = canvas.getByRole("textbox", { name: "搜索" });
  await user.type(input, "wx");
  const second = await canvas.findByRole("option", { name: /微\s*信\s*文\s*档\s*网页/ });
  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(second).toHaveAttribute("aria-selected", "true"));
  await user.keyboard("{ArrowDown}");
  expect(second).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
  expect(search.calls.execute).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(search.calls.execute).toHaveBeenCalledWith(expect.objectContaining({ token: 1, id: "two" }));
  await waitFor(() => expect(input).toHaveValue(""));
});

test("open clipboard after subscription is ready and return with Backspace", async () => {
  const clipboard = preview(true);
  const canvas = render(<Launcher services={clipboard.services} />);
  const user = userEvent.setup();
  await user.type(canvas.getByRole("textbox", { name: "搜索" }), "clipboard");
  await canvas.findByRole("option", { name: /剪\s*贴\s*板\s*命令/ });
  await user.keyboard("{Enter}");
  await canvas.findByRole("navigation", { name: "剪贴板视图" });
  await waitFor(() =>
    expect(clipboard.calls.resize).toHaveBeenLastCalledWith(
      expect.objectContaining({ resultCount: 0, mode: LauncherMode.CLIPBOARD }),
    ),
  );
  expect(clipboard.calls.hide).not.toHaveBeenCalled();
  await user.click(canvas.getByRole("textbox", { name: "搜索" }));
  await user.keyboard("{Backspace}");
  await waitFor(() =>
    expect(clipboard.calls.resize).toHaveBeenLastCalledWith(
      expect.objectContaining({ resultCount: 0, mode: LauncherMode.SEARCH }),
    ),
  );
  expect(canvas.queryByRole("navigation", { name: "剪贴板视图" })).toBeNull();
});

test("empty search opens native chat layout, sends through Llm and preserves history when collapsed", async () => {
  const app = preview();
  const canvas = render(<Launcher services={app.services} />);
  fireEvent.keyDown(canvas.getByRole("textbox", { name: "搜索" }), { key: "ArrowDown", isComposing: true });
  expect(canvas.queryByRole("textbox", { name: "快速对话输入" })).toBeNull();
  fireEvent.keyDown(canvas.getByRole("textbox", { name: "搜索" }), { key: "ArrowDown" });
  const input = await canvas.findByRole("textbox", { name: "快速对话输入" });
  expect(app.calls.resize).toHaveBeenLastCalledWith(expect.objectContaining({ mode: LauncherMode.QUICK_CHAT }));
  fireEvent.change(input, { target: { value: "Hello" } });
  await waitFor(() => expect(canvas.getByRole("button", { name: "发送消息" })).toBeEnabled());
  fireEvent.keyDown(input, { key: "Enter" });
  await canvas.findByText("Hello from LLM");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(app.calls.resize).toHaveBeenLastCalledWith(expect.objectContaining({ mode: LauncherMode.QUICK_CHAT }));
  await waitFor(() =>
    expect(app.calls.resize).toHaveBeenLastCalledWith(expect.objectContaining({ mode: LauncherMode.SEARCH })),
  );
  fireEvent.keyDown(await canvas.findByRole("textbox", { name: "搜索" }), { key: "ArrowDown" });
  await canvas.findByText("Hello from LLM");
  fireEvent.click(canvas.getByRole("button", { name: "新建对话" }));
  expect(canvas.queryByText("Hello from LLM")).toBeNull();
});
