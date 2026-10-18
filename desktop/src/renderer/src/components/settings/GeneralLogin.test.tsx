import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AccountManagementDialog } from "./AccountManagementDialog";
import { GeneralLoginPreview } from "./GeneralLoginPreview";
import { PasswordLoginDialog } from "./PasswordLoginDialog";

afterEach(cleanup);

test("add and select a server, then manage its session while signed in", async () => {
  render(<GeneralLoginPreview emptyServers />);
  const page = within(document.body);
  const actions = userEvent.setup();

  expect(page.getByRole("button", { name: "登录" })).toBeDisabled();
  expect(page.getByRole("button", { name: "登录服务器" })).toHaveTextContent("添加服务器");
  expect(page.queryByText("服务器", { exact: true })).not.toBeInTheDocument();
  await actions.click(page.getByRole("button", { name: "登录服务器" }));
  await actions.click(page.getByRole("button", { name: "+ 添加服务器" }));
  const add = within(page.getByRole("dialog", { name: "添加服务器" }));
  await actions.type(add.getByLabelText("服务器地址"), "http://127.0.0.1:10001/");
  await actions.click(add.getByRole("button", { name: "保存" }));

  expect(page.getByRole("button", { name: "登录服务器" })).toHaveTextContent("选择服务器");
  await actions.click(page.getByRole("button", { name: "登录服务器" }));
  await actions.click(page.getByRole("button", { name: "http://127.0.0.1:10001" }));
  await actions.click(page.getByRole("button", { name: "登录" }));
  const login = within(page.getByRole("dialog", { name: "登录" }));
  expect(login.getByText("http://127.0.0.1:10001")).toBeVisible();
  await actions.type(login.getByLabelText("邮箱"), "user@example.test");
  await actions.type(login.getByLabelText("密码"), "sample-password");
  await actions.click(login.getByRole("button", { name: "登录" }));

  await waitFor(() => expect(page.getByRole("button", { name: "管理" })).toBeVisible());
  expect(page.queryByRole("button", { name: "登录服务器" })).not.toBeInTheDocument();
  expect(page.getByText("http://127.0.0.1:10001")).toBeVisible();
  expect(page.getByText("u_7mK2qR9xW4nT8bYpC6dHfA")).toBeVisible();
  await actions.click(page.getByRole("button", { name: "管理" }));
  const management = within(page.getByRole("dialog", { name: "账号管理" }));
  expect(management.getByRole("button", { name: "退出" })).toBeDisabled();
  await actions.click(management.getByRole("button", { name: "退出全部" }));
  expect(page.queryByRole("dialog", { name: "账号管理" })).not.toBeInTheDocument();
  expect(page.getByRole("button", { name: "登录服务器" })).toHaveTextContent(
    "http://127.0.0.1:10001",
  );
});

test("management preserves sessions across switches and supports independent logout", async () => {
  render(<GeneralLoginPreview signedIn multipleSessions />);
  const page = within(document.body);
  const actions = userEvent.setup();
  await actions.click(page.getByRole("button", { name: "管理" }));
  const management = within(page.getByRole("dialog", { name: "账号管理" }));
  const local = within(management.getByRole("listitem", { name: "http://127.0.0.1:10001" }));
  const remote = within(
    management.getByRole("listitem", { name: "https://team.example.test/xiaowei" }),
  );

  expect(local.getByText("当前")).toBeVisible();
  expect(local.getByRole("button", { name: "退出" })).toBeDisabled();
  await actions.click(local.getByRole("button", { name: "退出" }));
  expect(local.getByText("当前")).toBeVisible();
  expect(local.getByText("u_7mK2qR9xW4nT8bYpC6dHfA")).toBeVisible();
  await actions.click(remote.getByRole("button", { name: "切换" }));
  expect(remote.getByText("当前")).toBeVisible();
  expect(remote.getByRole("button", { name: "退出" })).toBeDisabled();
  expect(local.getByRole("button", { name: "退出" })).toBeEnabled();
  expect(local.getByRole("button", { name: "切换" })).toBeVisible();
  await actions.click(local.getByRole("button", { name: "退出" }));
  expect(local.getByText("未登录")).toBeVisible();
  expect(remote.getByText("u_remote_8bYpC6dHfA")).toBeVisible();

  await actions.click(management.getByRole("button", { name: "退出全部" }));
  expect(page.queryByRole("dialog", { name: "账号管理" })).not.toBeInTheDocument();
  expect(page.getByRole("button", { name: "登录服务器" })).toHaveTextContent(
    "https://team.example.test/xiaowei",
  );
});

test("new server login activates on success and cancellation preserves the session", async () => {
  render(<GeneralLoginPreview signedIn />);
  const page = within(document.body);
  const actions = userEvent.setup();
  await actions.click(page.getByRole("button", { name: "管理" }));
  let management = within(page.getByRole("dialog", { name: "账号管理" }));
  await actions.click(management.getByRole("button", { name: "+ 添加新服务器" }));
  expect(page.getAllByRole("dialog")).toHaveLength(1);
  await actions.type(management.getByLabelText("服务器地址"), "https://new.example.test/");
  await actions.click(management.getByRole("button", { name: "添加" }));
  const localBeforeLogin = within(
    management.getByRole("listitem", { name: "http://127.0.0.1:10001" }),
  );
  expect(localBeforeLogin.getByText("当前")).toBeVisible();
  const newServer = within(management.getByRole("listitem", { name: "https://new.example.test" }));
  expect(newServer.getByText("未登录")).toBeVisible();
  await actions.click(newServer.getByRole("button", { name: "登录" }));
  let login = within(page.getByRole("dialog", { name: "登录" }));
  expect(login.getByText("https://new.example.test")).toBeVisible();
  await actions.type(login.getByLabelText("密码"), "cancelled-password");
  await actions.click(login.getByRole("button", { name: "取消" }));

  management = within(page.getByRole("dialog", { name: "账号管理" }));
  const local = within(management.getByRole("listitem", { name: "http://127.0.0.1:10001" }));
  expect(local.getByText("当前")).toBeVisible();
  const added = within(management.getByRole("listitem", { name: "https://new.example.test" }));
  expect(added.getByText("未登录")).toBeVisible();
  await actions.click(added.getByRole("button", { name: "登录" }));
  login = within(page.getByRole("dialog", { name: "登录" }));
  expect(login.getByLabelText("密码")).toHaveValue("");
  await actions.type(login.getByLabelText("邮箱"), "user@example.test");
  await actions.type(login.getByLabelText("密码"), "sample-password");
  await actions.click(login.getByRole("button", { name: "登录" }));

  await waitFor(() => expect(page.getByRole("dialog", { name: "账号管理" })).toBeVisible());
  management = within(page.getByRole("dialog", { name: "账号管理" }));
  expect(
    within(management.getByRole("listitem", { name: "https://new.example.test" })).getByText(
      "当前",
    ),
  ).toBeVisible();
  expect(
    within(management.getByRole("listitem", { name: "http://127.0.0.1:10001" })).getByRole(
      "button",
      {
        name: "切换",
      },
    ),
  ).toBeVisible();
});

test("inline adding shows validation loading, retains errors and supports retry", async () => {
  let reject!: (error: Error) => void;
  const blocked = new Promise<void>((_resolve, rejectRequest) => {
    reject = rejectRequest;
  });
  const add = vi.fn().mockReturnValueOnce(blocked).mockResolvedValueOnce(undefined);
  const page = within(document.body);
  const actions = userEvent.setup();
  render(
    <AccountManagementDialog
      servers={[{ address: "http://127.0.0.1:10001", uid: "u_current" }]}
      currentServer="http://127.0.0.1:10001"
      onClose={() => {}}
      onSwitch={() => {}}
      onLogin={() => {}}
      onLogout={() => {}}
      onLogoutAll={() => {}}
      onAddServer={add}
    />,
  );
  const management = within(page.getByRole("dialog", { name: "账号管理" }));
  await actions.click(management.getByRole("button", { name: "+ 添加新服务器" }));
  const address = management.getByLabelText("服务器地址");
  expect(address).toHaveFocus();
  await actions.type(address, "http://127.0.0.1:10001/");
  await actions.click(management.getByRole("button", { name: "添加" }));
  expect(management.getByRole("alert")).toHaveTextContent("该服务器地址已保存");
  expect(add).not.toHaveBeenCalled();

  await actions.clear(address);
  await actions.type(address, "https://new.example.test/");
  await actions.keyboard("{Enter}");
  expect(address).toBeDisabled();
  expect(management.getByRole("button", { name: "校验中…" })).toBeDisabled();
  expect(management.getByRole("button", { name: "取消" })).toBeDisabled();
  expect(add).toHaveBeenCalledExactlyOnceWith("https://new.example.test");
  reject(new Error("无法连接服务器"));
  await waitFor(() => expect(management.getByRole("alert")).toHaveTextContent("无法连接服务器"));
  expect(address).toHaveValue("https://new.example.test/");
  expect(address).toBeEnabled();

  await actions.click(management.getByRole("button", { name: "添加" }));
  await waitFor(() => expect(management.queryByLabelText("服务器地址")).not.toBeInTheDocument());
  expect(add).toHaveBeenCalledTimes(2);
  expect(management.getByText("u_current")).toBeVisible();
});

test("saved server selection determines the login target and closing clears the password", async () => {
  render(<GeneralLoginPreview />);
  const page = within(document.body);
  const actions = userEvent.setup();
  await actions.click(page.getByRole("button", { name: "登录服务器" }));
  await actions.click(page.getByRole("button", { name: "https://team.example.test/xiaowei" }));
  await actions.click(page.getByRole("button", { name: "登录" }));
  let login = within(page.getByRole("dialog", { name: "登录" }));
  expect(login.getByText("https://team.example.test/xiaowei")).toBeVisible();
  await actions.type(login.getByLabelText("密码"), "temporary-password");
  await actions.click(login.getByRole("button", { name: "取消" }));
  await actions.click(page.getByRole("button", { name: "登录" }));
  login = within(page.getByRole("dialog", { name: "登录" }));
  expect(login.getByLabelText("密码")).toHaveValue("");
});

test("login submits the original password and does not enforce the new-password policy", async () => {
  const submit = vi.fn();
  render(
    <PasswordLoginDialog server="http://127.0.0.1:10001" onClose={() => {}} onSubmit={submit} />,
  );
  const dialog = within(document.body);
  const actions = userEvent.setup();
  await actions.type(dialog.getByLabelText("邮箱"), "user@example.test");
  await actions.type(dialog.getByLabelText("密码"), "  x  ");
  await actions.keyboard("{Enter}");
  expect(submit).toHaveBeenCalledExactlyOnceWith("user@example.test", "  x  ");
});
