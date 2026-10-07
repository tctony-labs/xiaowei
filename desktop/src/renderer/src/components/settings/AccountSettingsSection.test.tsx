import { create, toBinary } from "@bufbuild/protobuf";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  Account,
  AccountChangedSchema,
  type AccountLoginRequest,
  AccountOperationResponseSchema,
  AccountSnapshotSchema,
  AccountStatus,
  EmptySchema,
  UserSnapshotSchema,
} from "xiaowei-contracts";
import { bindEvent, bindHandlers } from "xiaowei-gateway";
import { GatewayHost } from "xiaowei-gateway/host";
import { createServices } from "../../services";
import { AccountSettingsSection } from "./AccountSettingsSection";

afterEach(cleanup);

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
            user: create(UserSnapshotSchema, { userId: "u_public_identity" }),
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
    expect(page.queryByText("UID：u_public_identity")).not.toBeInTheDocument();
    expect(page.getByRole("button", { name: "登录服务器" })).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    vi.useRealTimers();
    expect(page.getByText("UID：u_public_identity")).toBeVisible();
    expect(page.queryByRole("dialog")).not.toBeInTheDocument();
    expect(page.queryByRole("button", { name: "登录服务器" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "退出登录" }));
    expect(await page.findByRole("button", { name: "登录服务器" })).toBeVisible();
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
      user: create(UserSnapshotSchema, { userId: "u_newer" }),
    });
    act(() =>
      owner.publish(
        AccountChangedSchema.typeName,
        toBinary(AccountChangedSchema, create(AccountChangedSchema, { snapshot: newer })),
      ),
    );
    expect(await within(document.body).findByText("UID：u_newer")).toBeVisible();
    await act(async () => release?.());
    expect(within(document.body).getByText("UID：u_newer")).toBeVisible();
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
