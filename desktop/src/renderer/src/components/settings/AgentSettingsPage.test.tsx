import { create, toBinary } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Settings,
  SettingsChangedSchema,
  SettingsSnapshotSchema,
  System,
  WebSearchProvider,
  WebSearchProviderTestResultSchema,
} from "proto-desktop-ts";
import { afterEach, expect, test, vi } from "vitest";
import { bindEvent, bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../../services";
import { AgentSettingsPage } from "./AgentSettingsPage";

afterEach(cleanup);

test("search settings save private keys and consume committed snapshots", async () => {
  const host = new GatewayHost();
  const changes = vi.fn();
  let fail = false;
  let snapshot = create(SettingsSnapshotSchema, {
    webSearch: {
      selectedProvider: WebSearchProvider.TAVILY,
      effectiveProvider: WebSearchProvider.TAVILY,
      configuredProviders: [WebSearchProvider.TAVILY],
    },
  });
  const owner = host.registerOwner(
    "settings",
    bindHandlers(
      Settings,
      {
        get: () => snapshot,
        update(request) {
          changes(request.change);
          if (fail) throw new Error("fixture failure");
          if (request.change.case === "webSearchApiKey" && !request.change.value.apiKey) {
            snapshot = create(SettingsSnapshotSchema, {
              webSearch: {
                selectedProvider: WebSearchProvider.BING,
                effectiveProvider: WebSearchProvider.BING,
              },
            });
          }
          return snapshot;
        },
        testWebSearchProvider: () =>
          create(WebSearchProviderTestResultSchema, {
            ok: false,
            error: "API Key 无效 (HTTP 401)",
          }),
      },
      { partial: true },
    ),
    [bindEvent(SettingsChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const openUrl = vi.fn(() => create(EmptySchema));
  host.registerOwner("system", bindHandlers(System, { openUrl }, { partial: true }));
  render(
    <AgentSettingsPage
      services={createServices(() => host.client({ caller: "test", trusted: true }))}
    />,
  );
  await screen.findByRole("button", { name: "修改 Tavily" });
  expect(screen.queryByText("单轮工具调用上限")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "修改 Tavily" }));
  expect(screen.getByLabelText("API Key")).toHaveValue("");
  await userEvent.type(screen.getByLabelText("API Key"), "new-fixture-key");
  fail = true;
  await userEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("保存搜索设置失败，请重试");
  expect(screen.getByRole("dialog")).toBeVisible();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(changes.mock.calls.at(-1)?.[0].value.apiKey).toBe("new-fixture-key");
  expect(screen.queryByDisplayValue("new-fixture-key")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "测试" }));
  await screen.findByText("API Key 无效 (HTTP 401)");
  await userEvent.click(screen.getByRole("button", { name: "修改 Tavily" }));
  await userEvent.click(screen.getByRole("button", { name: "删除 Key" }));
  await userEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "搜索源" })).toHaveTextContent("Bing"),
  );
  await act(async () => {
    snapshot = create(SettingsSnapshotSchema, {
      webSearch: {
        selectedProvider: WebSearchProvider.BRAVE,
        effectiveProvider: WebSearchProvider.BING,
      },
    });
    owner.publish(
      SettingsChangedSchema.typeName,
      toBinary(SettingsChangedSchema, create(SettingsChangedSchema, { snapshot })),
    );
  });
  expect(screen.getByRole("button", { name: "搜索源" })).toHaveTextContent("Brave");
  expect(screen.getByText(/当前使用 Bing/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "打开 Brave 网站" }));
  expect(openUrl).toHaveBeenCalledOnce();
});
