import { create, toBinary } from "@bufbuild/protobuf";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { EmptySchema, ModelSettings, ModelSettingsChangedSchema, ModelSettingsSnapshotSchema } from "xiaowei-contracts";
import { bindEvent, bindHandlers, bindStreamHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../../services";
import { ModelSettingsPage } from "./ModelSettingsPage";

afterEach(cleanup);

test("product model editor preserves stable IDs and hidden fields and saves only on final confirmation", async () => {
  const host = new GatewayHost();
  const snapshot = create(ModelSettingsSnapshotSchema, {
    revision: 1n,
    appliedRevision: 1n,
    defaults: { modelRef: "local-model" },
    providers: [
      {
        id: "provider",
        name: "Custom",
        provider: "custom",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        hasApiKey: true,
        transport: "http",
        models: [
          {
            id: "local-model",
            modelId: "upstream",
            name: "Display",
            contextWindow: 131072,
            maxTokens: 16384,
            compatJson: '{"supportsStore":false}',
            samplingParamsJson: '{"top_p":0.8}',
          },
        ],
      },
    ],
  });
  const save = vi.fn((request) => {
    expect(request.expectedRevision).toBe(1n);
    expect(request.provider.models[0].id).toBe("local-model");
    expect(request.provider.models[0].modelId).toBe("renamed-upstream");
    expect(request.provider.models[0].compatJson).toBe('{"supportsStore":false}');
    expect(request.key.operation.case).toBe("preserve");
    return snapshot;
  });
  const owner = host.registerOwner(
    "model-settings",
    bindHandlers(
      ModelSettings,
      {
        get: () => snapshot,
        saveProvider: save,
      },
      { partial: true },
    ),
    [bindEvent(ModelSettingsChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const services = createServices(() => host.client({ caller: "ui-test", trusted: true }));
  render(<ModelSettingsPage services={services} />);
  await screen.findByText("Custom");
  expect(screen.queryByText("图片生成模型")).toBeNull();
  expect(screen.queryByText("启用本地模型")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "修改" }));
  expect(screen.getByPlaceholderText("已配置 API Key，留空保留当前值")).toHaveValue("");
  await userEvent.click(screen.getByRole("button", { name: "编辑 upstream" }));
  fireEvent.change(screen.getByRole("textbox", { name: "模型 ID" }), { target: { value: "renamed-upstream" } });
  await userEvent.click(screen.getByRole("button", { name: "保存模型" }));
  expect(save).not.toHaveBeenCalled();
  // A newer event must not silently rebase the already-open editor onto a newer revision.
  await act(async () => {
    owner.publish(
      ModelSettingsChangedSchema.typeName,
      toBinary(
        ModelSettingsChangedSchema,
        create(ModelSettingsChangedSchema, { snapshot: { ...snapshot, revision: 2n } }),
      ),
    );
  });
  await userEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  const toast = await screen.findByRole("status");
  expect(toast).toHaveTextContent("已保存");
  expect(toast).toHaveClass("fixed");
  expect(toast.parentElement).toBe(document.body);
  await waitFor(() => expect(screen.queryByText("已保存")).toBeNull(), { timeout: 4000 });
  owner.close();
});

test("closing the import dialog cancels the Gateway stream", async () => {
  const host = new GatewayHost();
  const aborted = vi.fn();
  const owner = host.registerOwner(
    "model-settings",
    [
      ...bindHandlers(
        ModelSettings,
        { get: () => create(ModelSettingsSnapshotSchema, { revision: 1n }) },
        { partial: true },
      ),
      ...bindStreamHandlers(ModelSettings, {
        async *listModels(_request, _client, signal) {
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                aborted();
                resolve();
              },
              { once: true },
            ),
          );
          if (!signal.aborted) throw new Error("expected cancellation");
        },
      }),
    ],
    [bindEvent(ModelSettingsChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const services = createServices(() => host.client({ caller: "ui-test", trusted: true }));
  render(<ModelSettingsPage services={services} />);
  expect(await screen.findByText("暂无模型提供商，请添加")).toBeVisible();
  await userEvent.click(await screen.findByRole("button", { name: "添加" }));
  expect(screen.queryByText("请输入提供方名称")).toBeNull();
  const nameInput = screen.getByRole("textbox", { name: "名称" });
  expect(nameInput).toHaveAttribute("aria-invalid", "false");
  fireEvent.blur(nameInput);
  expect(screen.getByText("请输入提供方名称")).toBeVisible();
  fireEvent.change(nameInput, { target: { value: "Draft" } });
  expect(screen.queryByText("请输入提供方名称")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Base URL" }), { target: { value: "https://example.com/v1" } });
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test" } });
  await userEvent.click(screen.getByRole("button", { name: "导入模型" }));
  await screen.findByRole("status", { name: "加载模型" });
  await userEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(aborted).toHaveBeenCalledTimes(1));
  owner.close();
});

test("default thinking strength requires a selected model and offers only its supported levels", async () => {
  const host = new GatewayHost();
  let snapshot = create(ModelSettingsSnapshotSchema, {
    revision: 1n,
    providers: [
      {
        id: "provider",
        name: "Custom",
        provider: "custom",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        hasApiKey: true,
        models: [
          {
            id: "reasoning-model",
            modelId: "reasoner",
            reasoning: true,
            thinkingLevelMapJson: JSON.stringify({ off: "none", low: null, high: "high" }),
          },
          { id: "text-model", modelId: "text" },
        ],
      },
    ],
  });
  const owner = host.registerOwner(
    "model-settings",
    bindHandlers(
      ModelSettings,
      {
        get: () => snapshot,
        updateDefaults: (request) => {
          snapshot = create(ModelSettingsSnapshotSchema, { ...snapshot, defaults: request.defaults });
          return snapshot;
        },
      },
      { partial: true },
    ),
    [bindEvent(ModelSettingsChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const services = createServices(() => host.client({ caller: "ui-test", trusted: true }));
  render(<ModelSettingsPage services={services} />);

  const thinking = await screen.findByRole("button", { name: "默认思考强度" });
  expect(thinking).toBeDisabled();
  expect(thinking).toHaveTextContent("请先选择默认模型");
  const defaultModel = screen.getByRole("button", { name: "默认模型" });
  const smallModel = screen.getByText("小文本任务模型");
  expect(defaultModel.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(thinking.compareDocumentPosition(smallModel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  await userEvent.click(defaultModel);
  await userEvent.click(screen.getByRole("button", { name: "Custom / reasoner" }));
  await waitFor(() => expect(thinking).toBeEnabled());
  await userEvent.click(thinking);
  expect(screen.getByRole("button", { name: "关闭" })).toBeVisible();
  expect(screen.getByRole("button", { name: "较大" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "较小" })).toBeNull();
  expect(screen.queryByRole("button", { name: "中等" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "较大" }));
  await waitFor(() => expect(snapshot.defaults?.thinkingLevel).toBe("high"));

  await userEvent.click(defaultModel);
  await userEvent.click(screen.getByRole("button", { name: "Custom / text" }));
  await waitFor(() => expect(thinking).toBeDisabled());
  expect(thinking).toHaveTextContent("不支持推理");
  expect(snapshot.defaults?.thinkingLevel).toBe("");
  owner.close();
});
