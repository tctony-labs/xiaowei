import { create, toBinary } from "@bufbuild/protobuf";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import {
  ClipboardBiz,
  ClipboardCategoriesSchema,
  ClipboardChangedSchema,
  ClipboardItemsSchema,
  EmptySchema,
  ExecuteResponseSchema,
  LauncherMode,
  LauncherOpenedSchema,
  LauncherSearchResponseSchema,
  Launcher as LauncherService,
  ModelSettings,
  ModelSettingsChangedSchema,
  ModelSettingsSnapshotSchema,
  SettingsAnchor,
  System,
} from "xiaowei-contracts";
import { bindEvent, bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../services";
import { agentFixture } from "./agent-chat/test-fixture";
import { Launcher } from "./Launcher";

function preview(clipboardMode = false, noModels = false, smallTextModelRef = "") {
  const host = new GatewayHost();
  const calls = { execute: vi.fn(), resize: vi.fn(), hide: vi.fn(), openSettings: vi.fn(), copy: vi.fn() };
  host.registerOwner(
    "system",
    bindHandlers(
      System,
      {
        writeClipboardText(request) {
          calls.copy(request);
          return create(EmptySchema);
        },
        openSettings(request) {
          calls.openSettings(request);
          return create(EmptySchema);
        },
      },
      { partial: true },
    ),
  );
  const launcher = host.registerOwner(
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
            defaults: { modelRef: "default-model", smallTextModelRef },
            providers: noModels ? [] : [{ id: "provider", models: [{ id: "default-model" }] }],
          }),
      },
      { partial: true },
    ),
    [bindEvent(ModelSettingsChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const agent = agentFixture(host);

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

  return {
    agent,
    calls,
    services: createServices(() => host.client({ caller: "test", trusted: true })),
    openMode(mode: LauncherMode) {
      launcher.publish(
        LauncherOpenedSchema.typeName,
        toBinary(LauncherOpenedSchema, create(LauncherOpenedSchema, { mode })),
      );
    },
  };
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

test("empty search opens native chat layout, sends through Agent and preserves history when collapsed", async () => {
  const app = preview();
  const canvas = render(<Launcher services={app.services} />);
  fireEvent.keyDown(canvas.getByRole("textbox", { name: "搜索" }), { key: "ArrowDown", isComposing: true });
  expect(canvas.queryByRole("textbox", { name: "快速对话输入" })).toBeNull();
  fireEvent.keyDown(canvas.getByRole("textbox", { name: "搜索" }), { key: "ArrowDown" });
  const input = await canvas.findByRole("textbox", { name: "快速对话输入" });
  expect(app.calls.resize).toHaveBeenLastCalledWith(expect.objectContaining({ mode: LauncherMode.QUICK_CHAT }));
  fireEvent.click(canvas.getByRole("button", { name: "新建对话" }));
  canvas.getByRole("button", { name: "新建对话" }).focus();
  expect(input).not.toHaveFocus();
  fireEvent.focus(window);
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: "Hello" } });
  await waitFor(() => expect(canvas.getByRole("button", { name: "发送消息" })).toBeEnabled());
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(app.agent.requests).toHaveLength(1));
  act(() => app.agent.finish(undefined, "Hello from Agent"));
  await canvas.findByText("Hello from Agent");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(app.calls.resize).toHaveBeenLastCalledWith(expect.objectContaining({ mode: LauncherMode.QUICK_CHAT }));
  await waitFor(() =>
    expect(app.calls.resize).toHaveBeenLastCalledWith(expect.objectContaining({ mode: LauncherMode.SEARCH })),
  );
  fireEvent.keyDown(await canvas.findByRole("textbox", { name: "搜索" }), { key: "ArrowDown" });
  await canvas.findByText("Hello from Agent");
  fireEvent.click(canvas.getByRole("button", { name: "新建对话" }));
  await waitFor(() => expect(canvas.queryByText("Hello from Agent")).toBeNull());
});

test("clipboard switches directly to expanded quick chat without replaying the search transition", async () => {
  const app = preview();
  const canvas = render(<Launcher services={app.services} />);
  await waitFor(() => expect(app.calls.resize).toHaveBeenCalled());

  await act(async () => app.openMode(LauncherMode.CLIPBOARD));
  await canvas.findByRole("navigation", { name: "剪贴板视图" });
  await act(async () => app.openMode(LauncherMode.QUICK_CHAT));

  const input = await canvas.findByRole("textbox", { name: "快速对话输入" });
  const viewport = canvas.getByTestId("quick-chat-viewport");
  expect(viewport).toHaveAttribute("data-expanded", "true");
  expect(viewport).toHaveAttribute("data-animating", "false");
  expect(viewport).toHaveStyle({ height: "580px" });
  expect(input).toHaveFocus();

  fireEvent.keyDown(input, { key: "Escape" });
  expect(viewport).toHaveAttribute("data-animating", "true");
  const search = await canvas.findByRole("textbox", { name: "搜索" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  await waitFor(() => expect(viewport).toHaveAttribute("data-expanded", "true"));
  expect(viewport).toHaveAttribute("data-animating", "true");
});

test("mode notifications stay connected while switching through clipboard", async () => {
  const app = preview();
  const gateway = app.services.getGateway();
  const subscribe = gateway.subscribe.bind(gateway);
  let launcherSubscriptions = 0;
  let releaseReconnect = () => {};
  const reconnect = new Promise<void>((resolve) => {
    releaseReconnect = resolve;
  });
  const services = createServices(() => ({
    ...gateway,
    async subscribe(...args) {
      if (args[0] === LauncherOpenedSchema.typeName && ++launcherSubscriptions > 1) {
        // Model a cross-process subscription that has not attached yet.
        await reconnect;
      }
      return subscribe(...args);
    },
  }));
  const canvas = render(<Launcher services={services} />);
  await waitFor(() => expect(app.calls.resize).toHaveBeenCalled());

  try {
    await act(async () => app.openMode(LauncherMode.CLIPBOARD));
    await canvas.findByRole("navigation", { name: "剪贴板视图" });
    await act(async () => app.openMode(LauncherMode.QUICK_CHAT));

    const input = await canvas.findByRole("textbox", { name: "快速对话输入" });
    expect(input).toHaveFocus();
    expect(canvas.queryByRole("navigation", { name: "剪贴板视图" })).toBeNull();
    expect(canvas.getByTestId("quick-chat-viewport")).toHaveAttribute("data-animating", "false");
    expect(launcherSubscriptions).toBe(1);

    await act(async () => app.openMode(LauncherMode.CLIPBOARD));
    await canvas.findByRole("navigation", { name: "剪贴板视图" });
    await act(async () => app.openMode(LauncherMode.QUICK_CHAT));
    expect(await canvas.findByRole("textbox", { name: "快速对话输入" })).toHaveFocus();
    expect(launcherSubscriptions).toBe(1);
  } finally {
    await act(async () => releaseReconnect());
  }
});

test("empty model state opens the model provider setting through the product Gateway", async () => {
  const app = preview(false, true);
  const canvas = render(<Launcher services={app.services} />);
  fireEvent.keyDown(canvas.getByRole("textbox", { name: "搜索" }), { key: "ArrowDown" });
  const link = await canvas.findByRole("button", { name: "设置 - 模型" });
  expect(canvas.getByText("暂无可用模型")).toBeVisible();
  expect(canvas.queryByRole("alert")).toBeNull();
  await userEvent.click(link);
  await waitFor(() =>
    expect(app.calls.openSettings).toHaveBeenCalledWith(
      expect.objectContaining({ anchor: SettingsAnchor.MODEL_PROVIDERS }),
    ),
  );
});

test("Quick Chat menus copy the accepted session ID and confirm deletion through Agent", async () => {
  const app = preview();
  const canvas = render(<Launcher services={app.services} />);
  const user = userEvent.setup();
  fireEvent.keyDown(canvas.getByRole("textbox", { name: "搜索" }), { key: "ArrowDown" });
  const composer = await canvas.findByRole("textbox", { name: "快速对话输入" });
  await user.type(composer, "menu integration");
  await waitFor(() => expect(canvas.getByRole("button", { name: "发送消息" })).toBeEnabled());
  await user.keyboard("{Enter}");
  await waitFor(() => expect(app.agent.requests).toHaveLength(1));
  act(() => app.agent.finish());
  await waitFor(() => expect(canvas.queryByRole("button", { name: "停止生成" })).toBeNull());
  await user.click(canvas.getByRole("button", { name: "更多操作" }));
  await user.click(canvas.getByRole("button", { name: "Session ID" }));
  await waitFor(() =>
    expect(app.calls.copy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: app.agent.requests[0].sessionId }),
    ),
  );
  expect(await canvas.findByText("已复制")).toBeVisible();
  await user.click(canvas.getByRole("button", { name: "更多操作" }));
  await user.click(canvas.getByRole("button", { name: "删除会话" }));
  expect(app.agent.counts.deleted).toBe(0);
  await user.click(within(canvas.getByRole("dialog")).getByRole("button", { name: "删除" }));
  await waitFor(() => expect(app.agent.counts.deleted).toBe(1));
  expect(canvas.queryByRole("article", { name: "用户消息" })).toBeNull();
});

test("Quick Chat renames the session through Agent and updates its title and session list", async () => {
  const app = preview();
  const canvas = render(<Launcher services={app.services} />);
  const user = userEvent.setup();
  fireEvent.keyDown(canvas.getByRole("textbox", { name: "搜索" }), { key: "ArrowDown" });
  const composer = await canvas.findByRole("textbox", { name: "快速对话输入" });
  await user.type(composer, "rename integration");
  await waitFor(() => expect(canvas.getByRole("button", { name: "发送消息" })).toBeEnabled());
  await user.keyboard("{Enter}");
  await waitFor(() => expect(app.agent.requests).toHaveLength(1));
  act(() => app.agent.finish());
  await user.click(canvas.getByRole("button", { name: "更多操作" }));
  await user.click(canvas.getByRole("button", { name: "重命名" }));
  fireEvent.change(canvas.getByRole("textbox", { name: "对话标题" }), { target: { value: "  我的标题  " } });
  await user.keyboard("{Enter}");
  expect(await canvas.findByText("我的标题")).toBeVisible();
  expect(app.agent.setTitleRequests).toEqual([{ sessionId: app.agent.requests[0].sessionId, title: "我的标题" }]);
  expect(app.agent.titleRequests).toEqual([]);
  expect(app.agent.requests).toHaveLength(1);
  await user.click(canvas.getByRole("button", { name: "选择会话" }));
  expect(await canvas.findByRole("button", { name: "我的标题" })).toBeVisible();
});

test("Quick Chat displays automatic title events and manually updates through the Agent API", async () => {
  const app = preview(false, false, "small-model");
  const canvas = render(<Launcher services={app.services} />);
  const user = userEvent.setup();
  fireEvent.keyDown(canvas.getByRole("textbox", { name: "搜索" }), { key: "ArrowDown" });
  const composer = await canvas.findByRole("textbox", { name: "快速对话输入" });
  await user.type(composer, "title integration");
  await waitFor(() => expect(canvas.getByRole("button", { name: "发送消息" })).toBeEnabled());
  await user.keyboard("{Enter}");
  await waitFor(() => expect(app.agent.requests).toHaveLength(1));
  expect(app.agent.requests[0].titleModelRef).toBeUndefined();
  act(() => {
    app.agent.finish();
    app.agent.updateTitle("自动生成的标题");
  });
  expect(await canvas.findByText("自动生成的标题")).toBeVisible();
  await user.click(canvas.getByRole("button", { name: "更多操作" }));
  await user.click(canvas.getByRole("button", { name: "更新标题" }));
  expect(await canvas.findByText("生成的标题")).toBeVisible();
  expect(app.agent.titleRequests).toEqual([app.agent.requests[0].sessionId]);
  expect(app.agent.requests).toHaveLength(1);
});

test("manual title update gets missing auxiliary configuration from the Agent and offers settings", async () => {
  const app = preview();
  app.agent.setAuxiliaryAvailable(false);
  const canvas = render(<Launcher services={app.services} />);
  const user = userEvent.setup();
  fireEvent.keyDown(canvas.getByRole("textbox", { name: "搜索" }), { key: "ArrowDown" });
  const composer = await canvas.findByRole("textbox", { name: "快速对话输入" });
  await user.type(composer, "title settings");
  await waitFor(() => expect(canvas.getByRole("button", { name: "发送消息" })).toBeEnabled());
  await user.keyboard("{Enter}");
  await waitFor(() => expect(app.agent.requests).toHaveLength(1));
  act(() => app.agent.finish());
  await waitFor(() => expect(canvas.queryByRole("button", { name: "停止生成" })).toBeNull());
  await user.click(canvas.getByRole("button", { name: "更多操作" }));
  await user.click(canvas.getByRole("button", { name: "更新标题" }));
  expect(await canvas.findByText("尚未配置小文本任务模型，请先在设置中选择")).toBeVisible();
  expect(app.agent.titleRequests).toEqual([app.agent.requests[0].sessionId]);
  await user.click(canvas.getByRole("button", { name: "选择小文本任务模型" }));
  await waitFor(() =>
    expect(app.calls.openSettings).toHaveBeenCalledWith(
      expect.objectContaining({ anchor: SettingsAnchor.MODEL_PROVIDERS }),
    ),
  );
});
