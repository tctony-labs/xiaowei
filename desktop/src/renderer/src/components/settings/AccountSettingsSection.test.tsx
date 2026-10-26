import { create, toBinary } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Account,
  AccountChangedSchema,
  type AccountLoginRequest,
  AccountOperationResponseSchema,
  AccountSnapshotSchema,
  AccountStatus,
  AccountUserSchema,
  CloudConnectionStatus,
  ServerAccountSchema,
} from "proto-desktop-ts";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { bindEvent, bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../../services";
import { AccountSettingsSection } from "./AccountSettingsSection";

afterEach(cleanup);

test("inline adding cannot interrupt pending switching or logout-all", async () => {
  const first = "https://one.example.test";
  const second = "https://two.example.test";
  let snapshot = create(AccountSnapshotSchema, {
    revision: 1n,
    servers: [first, second],
    selectedServer: first,
    status: AccountStatus.SIGNED_IN,
    user: { userId: "one" },
    serverAccounts: [
      { serverAddress: first, user: { userId: "one" } },
      { serverAddress: second, user: { userId: "two" } },
    ],
  });
  let finish!: () => void;
  let additions = 0;
  let logoutAttempts = 0;
  const host = new GatewayHost();
  const owner = host.registerOwner(
    "account",
    bindHandlers(
      Account,
      {
        get: () => snapshot,
        selectServer: () =>
          new Promise((resolve) => {
            finish = () => resolve(create(AccountOperationResponseSchema, { snapshot }));
          }),
        addServer: () => {
          additions++;
          return create(AccountOperationResponseSchema, { snapshot });
        },
        logout: () =>
          new Promise((resolve) => {
            finish = () => {
              const partial = logoutAttempts++ === 0;
              snapshot = create(AccountSnapshotSchema, {
                ...snapshot,
                revision: snapshot.revision + 1n,
                status: AccountStatus.SIGNED_OUT,
                user: undefined,
                serverAccounts: partial ? [snapshot.serverAccounts[1]] : [],
              });
              resolve(
                create(AccountOperationResponseSchema, {
                  code: partial ? 10008 : 0,
                  msg: partial ? "1 个服务器退出失败" : "",
                  snapshot,
                }),
              );
            };
          }),
      },
      { partial: true },
    ),
    [bindEvent(AccountChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const services = createServices(() => host.client({ caller: "settings", trusted: true }));
  try {
    render(<AccountSettingsSection services={services} />);
    const page = within(document.body);
    const actions = userEvent.setup();
    await actions.click(await page.findByRole("button", { name: "管理" }));
    const dialog = within(page.getByRole("dialog", { name: "账号管理" }));
    await actions.click(dialog.getByRole("button", { name: "+ 添加新服务器" }));
    const address = dialog.getByRole("textbox", { name: "服务器地址" });
    await actions.type(address, "https://three.example.test");
    const row = within(dialog.getByRole("listitem", { name: second }));
    await actions.click(row.getByRole("button", { name: "切换" }));
    const verifyBlocked = async () => {
      expect(address).toBeDisabled();
      const add = dialog.getByRole("button", { name: "添加" });
      expect(add).toBeDisabled();
      await actions.click(add);
      const form = address.closest("form");
      if (!form) throw new Error("Missing inline add form");
      fireEvent.submit(form);
      expect(additions).toBe(0);
    };
    await verifyBlocked();
    await act(async () => finish());
    await actions.click(dialog.getByRole("button", { name: "退出全部" }));
    await verifyBlocked();
    await act(async () => finish());
    expect(dialog.getByRole("alert")).toHaveTextContent("1 个服务器退出失败");
    expect(page.getByRole("dialog", { name: "账号管理" })).toBeVisible();
    await actions.click(dialog.getByRole("button", { name: "退出全部" }));
    await verifyBlocked();
    await act(async () => finish());
    expect(page.queryByRole("dialog", { name: "账号管理" })).not.toBeInTheDocument();
    expect(additions).toBe(0);
  } finally {
    owner.close();
  }
});

test("signed-out adding waits for validation, keeps failures and cancels on close", async () => {
  const host = new GatewayHost();
  let snapshot = create(AccountSnapshotSchema, {
    revision: 1n,
    servers: ["http://127.0.0.1:10001"],
    selectedServer: "http://127.0.0.1:10001",
    status: AccountStatus.SIGNED_OUT,
  });
  let complete!: (code: number) => void;
  let cancelled = false;
  const owner = host.registerOwner(
    "account",
    bindHandlers(
      Account,
      {
        get: () => snapshot,
        addServer: async (request, client) => {
          client.cancellation().addEventListener("abort", () => {
            cancelled = true;
          });
          const code = await new Promise<number>((resolve) => {
            complete = resolve;
          });
          if (code === 0 && !client.cancellation().aborted) {
            snapshot = create(AccountSnapshotSchema, {
              ...snapshot,
              revision: snapshot.revision + 1n,
              servers: [...snapshot.servers, request.serverAddress],
            });
          }
          return create(AccountOperationResponseSchema, {
            code,
            msg: code ? "无法连接服务器" : "",
            snapshot,
          });
        },
      },
      { partial: true },
    ),
    [bindEvent(AccountChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const services = createServices(() => host.client({ caller: "settings", trusted: true }));
  try {
    render(<AccountSettingsSection services={services} />);
    const page = within(document.body);
    await userEvent.click(await page.findByRole("button", { name: "登录服务器" }));
    await userEvent.click(page.getByRole("button", { name: "+ 添加服务器" }));
    const add = within(page.getByRole("dialog", { name: "添加服务器" }));
    const address = add.getByLabelText("服务器地址");
    await userEvent.type(address, "https://new.example.test");
    await userEvent.click(add.getByRole("button", { name: "保存" }));
    expect(await add.findByRole("button", { name: "校验中…" })).toBeDisabled();
    expect(address).toBeDisabled();
    await act(async () => complete(10008));
    expect(await add.findByRole("alert")).toHaveTextContent("无法连接服务器");
    expect(address).toHaveValue("https://new.example.test");
    expect(address).toBeEnabled();

    await userEvent.click(add.getByRole("button", { name: "保存" }));
    await add.findByRole("button", { name: "校验中…" });
    await userEvent.click(add.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(cancelled).toBe(true));
    await act(async () => complete(0));
    expect(page.queryByRole("dialog")).not.toBeInTheDocument();
    expect(snapshot.servers).toEqual(["http://127.0.0.1:10001"]);
    expect(page.getByRole("button", { name: "登录服务器" })).toHaveTextContent(
      "http://127.0.0.1:10001",
    );
  } finally {
    cleanup();
    owner.close();
  }
});

test("real typed client logs in, shows the public UID and restores the selector after logout", async () => {
  const host = new GatewayHost();
  let snapshot = create(AccountSnapshotSchema, {
    revision: 1n,
    servers: ["http://127.0.0.1:10001"],
    selectedServer: "http://127.0.0.1:10001",
    status: AccountStatus.SIGNED_OUT,
  });
  const requests: AccountLoginRequest[] = [];
  const owner = host.registerOwner(
    "account",
    bindHandlers(
      Account,
      {
        get: () => snapshot,
        login(request) {
          requests.push(request);
          if (requests.length === 1)
            return create(AccountOperationResponseSchema, {
              code: 10100,
              msg: "邮箱或密码错误",
              snapshot,
            });
          snapshot = create(AccountSnapshotSchema, {
            ...snapshot,
            revision: 2n,
            status: AccountStatus.SIGNED_IN,
            user: create(AccountUserSchema, { userId: "u_public_identity" }),
            serverAccounts: [
              create(ServerAccountSchema, {
                serverAddress: snapshot.selectedServer,
                user: create(AccountUserSchema, { userId: "u_public_identity" }),
              }),
            ],
          });
          owner.publish(
            AccountChangedSchema.typeName,
            toBinary(AccountChangedSchema, create(AccountChangedSchema, { snapshot })),
          );
          return create(AccountOperationResponseSchema, { snapshot });
        },
        cancelLogin: () => create(EmptySchema),
        logout() {
          snapshot = create(AccountSnapshotSchema, {
            ...snapshot,
            revision: 3n,
            status: AccountStatus.SIGNED_OUT,
            user: undefined,
            serverAccounts: [],
          });
          return create(AccountOperationResponseSchema, { snapshot });
        },
      },
      { partial: true },
    ),
    [bindEvent(AccountChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const services = createServices(() => host.client({ caller: "settings", trusted: true }));
  try {
    render(<AccountSettingsSection services={services} />);
    const page = within(document.body);
    await userEvent.click(await page.findByRole("button", { name: "登录" }));
    const login = within(page.getByRole("dialog", { name: "登录" }));
    await userEvent.type(login.getByLabelText("邮箱"), "user@example.test");
    await userEvent.type(login.getByLabelText("密码"), "  sample  ");
    vi.useFakeTimers();
    fireEvent.click(login.getByRole("button", { name: "登录" }));
    await act(async () => {});
    expect(login.getByRole("button", { name: "登录中…" })).toBeDisabled();
    expect(login.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(login.getByRole("button", { name: "登录中…" })).toBeDisabled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(login.getByRole("alert")).toHaveTextContent("邮箱或密码错误");
    expect(login.getByRole("alert").closest("form")).toBeNull();
    vi.useRealTimers();
    expect(requests[0].password?.password).toBe("  sample  ");
    expect(requests[0].serverAddress).toBe("http://127.0.0.1:10001");
    vi.useFakeTimers();
    fireEvent.click(login.getByRole("button", { name: "登录" }));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(login.getByRole("button", { name: "登录中…" })).toBeDisabled();
    expect(page.queryByText("u_public_identity")).not.toBeInTheDocument();
    expect(page.getByRole("button", { name: "登录服务器" })).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    vi.useRealTimers();
    expect(page.getByText("u_public_identity")).toBeVisible();
    expect(page.queryByRole("dialog")).not.toBeInTheDocument();
    expect(page.queryByRole("button", { name: "登录服务器" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "管理" }));
    const management = within(page.getByRole("dialog", { name: "账号管理" }));
    await userEvent.click(management.getByRole("button", { name: "退出全部" }));
    expect(page.queryByRole("dialog", { name: "账号管理" })).not.toBeInTheDocument();
    expect(await page.findByRole("button", { name: "登录服务器" })).toBeVisible();
  } finally {
    vi.useRealTimers();
    cleanup();
    owner.close();
  }
});

test("management connects typed switching, adding, login and partial logout-all", async () => {
  const first = "http://127.0.0.1:10001";
  const second = "https://remote.example.test";
  const third = "https://new.example.test";
  const host = new GatewayHost();
  const saved = (serverAddress: string, userId: string) =>
    create(ServerAccountSchema, {
      serverAddress,
      user: create(AccountUserSchema, { userId }),
    });
  let snapshot = create(AccountSnapshotSchema, {
    revision: 1n,
    servers: [first, second],
    selectedServer: first,
    status: AccountStatus.SIGNED_IN,
    user: create(AccountUserSchema, { userId: "u_first" }),
    serverAccounts: [saved(first, "u_first"), saved(second, "u_second")],
  });
  let logoutAllAttempts = 0;
  const logoutTargets: string[] = [];
  const owner = host.registerOwner(
    "account",
    bindHandlers(
      Account,
      {
        get: () => snapshot,
        selectServer(request) {
          snapshot = create(AccountSnapshotSchema, {
            ...snapshot,
            revision: snapshot.revision + 1n,
            selectedServer: request.serverAddress,
            user: snapshot.serverAccounts.find(
              (entry) => entry.serverAddress === request.serverAddress,
            )?.user,
          });
          return create(AccountOperationResponseSchema, { snapshot });
        },
        addServer(request) {
          snapshot = create(AccountSnapshotSchema, {
            ...snapshot,
            revision: snapshot.revision + 1n,
            servers: [...snapshot.servers, request.serverAddress],
          });
          return create(AccountOperationResponseSchema, { snapshot });
        },
        login(request) {
          expect(request.serverAddress).toBe(third);
          if (request.password?.password === "wrong") {
            return create(AccountOperationResponseSchema, {
              code: 10100,
              msg: "邮箱或密码错误",
              snapshot,
            });
          }
          snapshot = create(AccountSnapshotSchema, {
            ...snapshot,
            revision: snapshot.revision + 1n,
            selectedServer: third,
            user: create(AccountUserSchema, { userId: "u_third" }),
            serverAccounts: [...snapshot.serverAccounts, saved(third, "u_third")],
          });
          owner.publish(
            AccountChangedSchema.typeName,
            toBinary(AccountChangedSchema, create(AccountChangedSchema, { snapshot })),
          );
          return create(AccountOperationResponseSchema, { snapshot });
        },
        logout(request) {
          logoutTargets.push(request.allServers ? "all" : request.serverAddress);
          const partial = request.allServers && logoutAllAttempts++ === 0;
          snapshot = create(AccountSnapshotSchema, {
            ...snapshot,
            revision: snapshot.revision + 1n,
            status: request.allServers ? AccountStatus.SIGNED_OUT : snapshot.status,
            user: request.allServers ? undefined : snapshot.user,
            serverAccounts: snapshot.serverAccounts.filter((entry) =>
              request.allServers
                ? partial && entry.serverAddress === second
                : entry.serverAddress !== request.serverAddress,
            ),
          });
          return create(AccountOperationResponseSchema, {
            code: partial ? 10008 : 0,
            msg: partial ? "1 个服务器退出失败，请重试" : "",
            snapshot,
          });
        },
        cancelLogin: () => create(EmptySchema),
      },
      { partial: true },
    ),
    [bindEvent(AccountChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const services = createServices(() => host.client({ caller: "settings", trusted: true }));
  try {
    const { container } = render(<AccountSettingsSection services={services} />);
    const card = within(container);
    const page = within(document.body);
    const actions = userEvent.setup();
    await actions.click(await page.findByRole("button", { name: "管理" }));
    let management = within(page.getByRole("dialog", { name: "账号管理" }));
    const row = (address: string) => within(management.getByRole("listitem", { name: address }));
    expect(row(first).getByRole("button", { name: "退出" })).toBeDisabled();
    await actions.click(row(second).getByRole("button", { name: "切换" }));
    expect(row(second).getByText("当前")).toBeVisible();
    expect(card.getByText("u_second")).toBeVisible();
    await actions.click(row(first).getByRole("button", { name: "退出" }));
    expect(row(first).getByText("未登录")).toBeVisible();
    expect(card.getByText("u_second")).toBeVisible();
    expect(logoutTargets).toEqual([first]);

    await actions.click(management.getByRole("button", { name: "+ 添加新服务器" }));
    await actions.type(management.getByLabelText("服务器地址"), third);
    await actions.click(management.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(row(third).getByText("未登录")).toBeVisible());
    expect(row(second).getByText("当前")).toBeVisible();
    await actions.click(row(third).getByRole("button", { name: "登录" }));
    const login = within(page.getByRole("dialog", { name: "登录" }));
    await actions.type(login.getByLabelText("邮箱"), "user@example.test");
    await actions.type(login.getByLabelText("密码"), "wrong");
    vi.useFakeTimers();
    fireEvent.click(login.getByRole("button", { name: "登录" }));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(login.getByRole("alert")).toHaveTextContent("邮箱或密码错误");
    expect(card.getByText("u_second")).toBeVisible();
    fireEvent.change(login.getByLabelText("密码"), { target: { value: "correct" } });
    fireEvent.click(login.getByRole("button", { name: "登录" }));
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(card.getByText("u_second")).toBeVisible();
    expect(card.queryByText("u_third")).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    vi.useRealTimers();
    management = within(page.getByRole("dialog", { name: "账号管理" }));
    expect(row(third).getByText("当前")).toBeVisible();
    expect(card.getByText("u_third")).toBeVisible();
    expect(row(second).getByRole("button", { name: "切换" })).toBeVisible();

    await actions.click(management.getByRole("button", { name: "退出全部" }));
    expect(management.getByRole("alert")).toHaveTextContent("1 个服务器退出失败");
    expect(row(second).getByText("u_second")).toBeVisible();
    expect(row(third).getByText("未登录")).toBeVisible();
    await actions.click(management.getByRole("button", { name: "退出全部" }));
    expect(page.queryByRole("dialog", { name: "账号管理" })).not.toBeInTheDocument();
    expect(card.getByRole("button", { name: "登录服务器" })).toHaveTextContent(third);
    expect(logoutTargets).toEqual([first, "all", "all"]);
  } finally {
    vi.useRealTimers();
    cleanup();
    owner.close();
  }
});

test("subscription precedes the initial snapshot and stale replies cannot overwrite newer account state", async () => {
  const host = new GatewayHost();
  let release: (() => void) | undefined;
  const initial = create(AccountSnapshotSchema, {
    revision: 1n,
    status: AccountStatus.SIGNED_OUT,
    servers: ["http://127.0.0.1:10001"],
    selectedServer: "http://127.0.0.1:10001",
  });
  const owner = host.registerOwner(
    "account",
    bindHandlers(
      Account,
      {
        get: async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return initial;
        },
      },
      { partial: true },
    ),
    [bindEvent(AccountChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const services = createServices(() => host.client({ caller: "settings", trusted: true }));
  try {
    render(
      <StrictMode>
        <AccountSettingsSection services={services} />
      </StrictMode>,
    );
    await waitFor(() => expect(release).toBeDefined());
    const newer = create(AccountSnapshotSchema, {
      ...initial,
      revision: 2n,
      status: AccountStatus.SIGNED_IN,
      user: create(AccountUserSchema, { userId: "u_newer" }),
    });
    act(() =>
      owner.publish(
        AccountChangedSchema.typeName,
        toBinary(AccountChangedSchema, create(AccountChangedSchema, { snapshot: newer })),
      ),
    );
    expect(await within(document.body).findByText("u_newer")).toBeVisible();
    await act(async () => release?.());
    expect(within(document.body).getByText("u_newer")).toBeVisible();
  } finally {
    cleanup();
    owner.close();
  }
});

test("closing the login overlay cancels its attempt and ignores a late failure", async () => {
  const host = new GatewayHost();
  const cancel = vi.fn();
  let release: (() => void) | undefined;
  let request: AccountLoginRequest | undefined;
  const snapshot = create(AccountSnapshotSchema, {
    revision: 1n,
    status: AccountStatus.SIGNED_OUT,
    servers: ["http://127.0.0.1:10001"],
    selectedServer: "http://127.0.0.1:10001",
  });
  const owner = host.registerOwner(
    "account",
    bindHandlers(
      Account,
      {
        get: () => snapshot,
        login: async (value) => {
          request = value;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return create(AccountOperationResponseSchema, { code: 10008, msg: "迟到错误", snapshot });
        },
        cancelLogin(value) {
          cancel(value.attemptId);
          return create(EmptySchema);
        },
      },
      { partial: true },
    ),
    [bindEvent(AccountChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const services = createServices(() => host.client({ caller: "settings", trusted: true }));
  try {
    render(<AccountSettingsSection services={services} />);
    const page = within(document.body);
    await userEvent.click(await page.findByRole("button", { name: "登录" }));
    const login = within(page.getByRole("dialog", { name: "登录" }));
    await userEvent.type(login.getByLabelText("邮箱"), "user@example.test");
    await userEvent.type(login.getByLabelText("密码"), "sample");
    await userEvent.click(login.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(release).toBeDefined());
    await userEvent.click(login.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(request?.attemptId));
    await act(async () => release?.());
    expect(page.queryByText("迟到错误")).not.toBeInTheDocument();
    expect(page.queryByRole("dialog")).not.toBeInTheDocument();
  } finally {
    cleanup();
    owner.close();
  }
});

test("cloud reconnect state changes without removing the signed-in account", async () => {
  const host = new GatewayHost();
  let snapshot = create(AccountSnapshotSchema, {
    revision: 1n,
    status: AccountStatus.SIGNED_IN,
    servers: ["https://example.test"],
    selectedServer: "https://example.test",
    user: create(AccountUserSchema, { userId: "u_still_signed_in" }),
    cloudConnection: CloudConnectionStatus.CONNECTED,
  });
  const owner = host.registerOwner(
    "account",
    bindHandlers(Account, { get: () => snapshot }, { partial: true }),
    [bindEvent(AccountChangedSchema, EmptySchema, "coalesce", () => true)],
  );
  const services = createServices(() => host.client({ caller: "settings", trusted: true }));
  const page = render(<AccountSettingsSection services={services} />);
  try {
    await page.findByRole("status", { name: "云连接：已连接" });
    snapshot = create(AccountSnapshotSchema, {
      ...snapshot,
      revision: 2n,
      cloudConnection: CloudConnectionStatus.RECONNECTING,
    });
    await act(async () =>
      owner.publish(
        AccountChangedSchema.typeName,
        toBinary(AccountChangedSchema, create(AccountChangedSchema, { snapshot })),
      ),
    );
    const reconnecting = await page.findByRole("status", { name: "云连接：连接中断，正在重连" });
    expect(reconnecting).toBeVisible();
    expect(page.getByText("u_still_signed_in")).toBeVisible();
    expect(page.queryByRole("button", { name: "登录服务器" })).not.toBeInTheDocument();
  } finally {
    page.unmount();
    owner.close();
  }
});
