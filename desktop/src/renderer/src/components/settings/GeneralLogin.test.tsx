import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { GeneralLoginPreview } from "./GeneralLoginPreview";
import { PasswordLoginDialog } from "./PasswordLoginDialog";

afterEach(cleanup);

test("add and select a server, then lock its address while signed in", async () => {
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

  expect(page.getByRole("button", { name: "登录服务器" })).toHaveTextContent("http://127.0.0.1:10001");
  await actions.click(page.getByRole("button", { name: "登录" }));
  const login = within(page.getByRole("dialog", { name: "登录" }));
  expect(login.getByText("http://127.0.0.1:10001")).toBeVisible();
  await actions.type(login.getByLabelText("邮箱"), "user@example.test");
  await actions.type(login.getByLabelText("密码"), "sample-password");
  await actions.click(login.getByRole("button", { name: "登录" }));

  await waitFor(() => expect(page.getByRole("button", { name: "退出登录" })).toBeVisible());
  expect(page.queryByRole("button", { name: "登录服务器" })).not.toBeInTheDocument();
  expect(page.getByText("http://127.0.0.1:10001")).toBeVisible();
  expect(page.getByText(/UID：u_/)).toBeVisible();
  await actions.click(page.getByRole("button", { name: "退出登录" }));
  expect(page.getByRole("button", { name: "登录服务器" })).toHaveTextContent("http://127.0.0.1:10001");
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
  render(<PasswordLoginDialog server="http://127.0.0.1:10001" onClose={() => {}} onSubmit={submit} />);
  const dialog = within(document.body);
  const actions = userEvent.setup();
  await actions.type(dialog.getByLabelText("邮箱"), "user@example.test");
  await actions.type(dialog.getByLabelText("密码"), "  x  ");
  await actions.keyboard("{Enter}");
  expect(submit).toHaveBeenCalledExactlyOnceWith("user@example.test", "  x  ");
});
