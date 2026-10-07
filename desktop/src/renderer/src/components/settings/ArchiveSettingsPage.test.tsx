import { create } from "@bufbuild/protobuf";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import {
  Agent,
  AgentSessionSummarySchema,
  DeleteSessionResponseSchema,
  DeleteSessionStatus,
  ListSessionsResponseSchema,
  SessionRetentionPolicySchema,
  SetSessionArchivedResponseSchema,
} from "xiaowei-contracts";
import { bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../../services";
import { ArchiveSettingsPage } from "./ArchiveSettingsPage";

afterEach(cleanup);

function fixture() {
  const host = new GatewayHost();
  let items = ["match one", "match two", "match three", "other"].map((title, index) =>
    create(AgentSessionSummarySchema, {
      sessionId: `session-${index}`,
      title,
      archived: true,
      archiveRevision: 2n,
      metadataRevision: 4n,
      updatedAtMs: 1n,
    }),
  );
  const list = vi.fn((request) => {
    const matches = items.filter((item) => item.title.includes(request.query));
    const offset = Number(request.continuation || 0);
    return create(ListSessionsResponseSchema, {
      sessions: matches.slice(offset, offset + 2),
      continuation: offset + 2 < matches.length ? String(offset + 2) : "",
    });
  });
  const remove = vi.fn((request) => {
    const ids = new Set(request.targets.map((target: { sessionId: string }) => target.sessionId));
    items = items.filter((item) => !ids.has(item.sessionId));
    return create(DeleteSessionResponseSchema, {
      results: request.targets.map((target: { sessionId: string }) => ({
        sessionId: target.sessionId,
        status: DeleteSessionStatus.DELETED,
      })),
    });
  });
  const restore = vi.fn((request) => {
    items = items.filter((item) => item.sessionId !== request.sessionId);
    return create(SetSessionArchivedResponseSchema, { archiveRevision: 3n });
  });
  let policy = create(SessionRetentionPolicySchema, { archiveAfterDays: 3 });
  const getPolicy = vi.fn(() => policy);
  const setPolicy = vi.fn((request) => {
    policy = request.policy;
    return policy;
  });
  const owner = host.registerOwner(
    "archive-agent",
    bindHandlers(
      Agent,
      {
        listSessions: list,
        getSessionRetentionPolicy: getPolicy,
        setSessionRetentionPolicy: setPolicy,
        deleteSession: remove,
        setSessionArchived: restore,
      },
      { partial: true },
    ),
  );
  const services = createServices(() => host.client({ caller: "settings-test", trusted: true }));
  return { services, list, remove, restore, getPolicy, setPolicy, owner };
}

test("single deletion keeps query, confirms the selected row and refreshes the first page", async () => {
  const f = fixture();
  const view = render(<ArchiveSettingsPage services={f.services} />);
  await screen.findByText("match one");
  expect(screen.getByText("归档不活跃的对话")).toBeVisible();
  expect(screen.getByText("清理不活跃的对话")).toBeVisible();
  expect(screen.queryByRole("button", { name: "删除全部" })).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("搜索标题"), { target: { value: "match" } });
  await waitFor(() => expect(screen.getAllByRole("button", { name: "删除" })[0]).toBeEnabled());
  await userEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
  expect(screen.getByRole("dialog")).toHaveTextContent("match one");
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
  expect(f.remove).not.toHaveBeenCalled();
  await userEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除" }));
  await waitFor(() => expect(screen.queryByText("match one")).toBeNull());
  await screen.findByText("match three");
  expect(f.remove.mock.calls[0][0].targets).toMatchObject([
    { sessionId: "session-0", expectedMetadataRevision: 4n, expectedArchiveRevision: 2n },
  ]);
  expect(screen.getByPlaceholderText("搜索标题")).toHaveValue("match");
  expect(f.list.mock.lastCall?.[0]).toMatchObject({ query: "match", archived: true, continuation: "" });
  expect(screen.queryByText("other")).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("搜索标题"), { target: { value: "" } });
  await waitFor(() => expect(f.list.mock.lastCall?.[0].query).toBe(""));
  expect(screen.queryByText("match one")).toBeNull();
  view.unmount();
  f.owner.close();
});

test("restore only unarchives and toasts; failures preserve the row and permit retry", async () => {
  const f = fixture();
  f.restore.mockImplementationOnce(() => {
    throw new Error("restore failure");
  });
  const view = render(<ArchiveSettingsPage services={f.services} />);
  await screen.findByText("match one");
  await userEvent.click(screen.getAllByRole("button", { name: "恢复" })[0]);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("操作失败"));
  expect(screen.getByText("match one")).toBeVisible();
  await waitFor(() => expect(screen.getAllByRole("button", { name: "恢复" })[0]).toBeEnabled());
  await userEvent.click(screen.getAllByRole("button", { name: "恢复" })[0]);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已恢复对话"));
  await waitFor(() => expect(screen.queryByText("match one")).toBeNull());
  expect(f.restore.mock.lastCall?.[0]).toMatchObject({
    sessionId: "session-0",
    archived: false,
    expectedArchiveRevision: 2n,
  });
  expect(screen.getByText("对话归档")).toBeVisible();
  view.unmount();
  f.owner.close();
});

test("failed single deletion displays the failure then reloads the actual list", async () => {
  const f = fixture();
  f.remove.mockImplementationOnce((request) =>
    create(DeleteSessionResponseSchema, {
      results: request.targets.map((target: { sessionId: string }, index: number) => ({
        sessionId: target.sessionId,
        status: index ? DeleteSessionStatus.NOT_EXECUTED : DeleteSessionStatus.FAILED,
        error: index ? "" : "磁盘不可写",
      })),
    }),
  );
  const view = render(<ArchiveSettingsPage services={f.services} />);
  await screen.findByText("match one");
  await userEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("未执行 0 条。删除失败：磁盘不可写"));
  await waitFor(() => expect(f.list).toHaveBeenCalledTimes(2));
  expect(screen.getByText("match one")).toBeVisible();
  view.unmount();
  f.owner.close();
});

test("a late response for a previous query cannot replace the current archive list", async () => {
  const f = fixture();
  let resolve!: (value: ReturnType<typeof create<typeof ListSessionsResponseSchema>>) => void;
  f.list.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }) as never,
  );
  const view = render(<ArchiveSettingsPage services={f.services} />);
  await waitFor(() => expect(f.list).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByPlaceholderText("搜索标题"), { target: { value: "other" } });
  await screen.findByText("other");
  resolve(
    create(ListSessionsResponseSchema, {
      sessions: [create(AgentSessionSummarySchema, { sessionId: "late", title: "late response" })],
    }),
  );
  await waitFor(() => expect(screen.queryByText("late response")).toBeNull());
  expect(screen.getByText("other")).toBeVisible();
  view.unmount();
  f.owner.close();
});

test("load more appends filtered rows without a delete-all entry", async () => {
  const f = fixture();
  const view = render(<ArchiveSettingsPage services={f.services} />);
  await screen.findByText("match one");
  fireEvent.change(screen.getByPlaceholderText("搜索标题"), { target: { value: "match" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "加载更多" })).toBeEnabled());
  await userEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByText("match three");
  expect(screen.getByText("match one")).toBeVisible();
  expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  expect(screen.queryByRole("button", { name: "删除全部" })).toBeNull();
  expect(f.remove).not.toHaveBeenCalled();
  view.unmount();
  f.owner.close();
});

test("retention settings persist both choices, preserve old values on failure and reload", async () => {
  const f = fixture();
  const view = render(<ArchiveSettingsPage services={f.services} />);
  const archive = await screen.findByRole("button", { name: "归档不活跃的对话" });
  await waitFor(() => expect(archive).toBeEnabled());
  expect(archive).toHaveTextContent("3 天");
  const deletion = screen.getByRole("button", { name: "清理不活跃的对话" });
  expect(deletion).toHaveTextContent("关闭");
  await userEvent.click(archive);
  await userEvent.click(screen.getByRole("button", { name: "7 天" }));
  await waitFor(() => expect(archive).toHaveTextContent("7 天"));
  expect(f.setPolicy.mock.lastCall?.[0].policy).toMatchObject({ archiveAfterDays: 7, deleteAfterDays: 0 });
  f.setPolicy.mockImplementationOnce(() => {
    throw new Error("不可写");
  });
  await userEvent.click(deletion);
  await userEvent.click(screen.getByRole("button", { name: "1 个月" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("保存自动归档设置失败"));
  expect(deletion).toHaveTextContent("关闭");
  await userEvent.click(deletion);
  await userEvent.click(screen.getByRole("button", { name: "1 个月" }));
  await waitFor(() => expect(deletion).toHaveTextContent("1 个月"));
  view.unmount();
  render(<ArchiveSettingsPage services={f.services} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "归档不活跃的对话" })).toHaveTextContent("7 天"));
  expect(screen.getByRole("button", { name: "清理不活跃的对话" })).toHaveTextContent("1 个月");
  f.owner.close();
});

test("policy load failure leaves archive data usable and can be retried", async () => {
  const f = fixture();
  f.getPolicy.mockImplementationOnce(() => {
    throw new Error("暂不可用");
  });
  const view = render(<ArchiveSettingsPage services={f.services} />);
  await screen.findByText("match one");
  await screen.findByText(/加载自动归档设置失败/);
  expect(screen.getByRole("button", { name: "归档不活跃的对话" })).toBeDisabled();
  expect(screen.getAllByRole("button", { name: "恢复" })[0]).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "归档不活跃的对话" })).toBeEnabled());
  expect(screen.queryByText(/加载自动归档设置失败/)).toBeNull();
  view.unmount();
  f.owner.close();
});
