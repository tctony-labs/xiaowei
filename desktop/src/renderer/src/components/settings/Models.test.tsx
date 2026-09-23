import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { SettingsPreview } from "./SettingsPreview";

afterEach(cleanup);

test("AddPresetProvider", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  await expect(page.getByLabelText("Base URL")).toHaveAttribute("readonly");
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await expect(page.getByLabelText("Base URL")).not.toHaveAttribute("readonly");
  await expect(page.getByRole("button", { name: "openai-completions" })).toBeEnabled();
});

test("SaveFailure", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="edit" operationFailure />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(page.getByRole("alert")).toHaveTextContent("操作失败"));
  await expect(page.getByRole("dialog", { name: "修改模型提供商" })).toBeVisible();
});

test("ProviderInteractions", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  await userEvent.click(page.getAllByRole("button", { name: /^配置 / })[0]);
  await expect(within(page.getByRole("dialog")).getAllByRole("button", { name: "未设置" })[0]).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  await expect(page.getByText("Transport", { exact: true })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "删除" }));
  await expect(page.getByRole("button", { name: "确认删除" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  await expect(page.queryByRole("dialog")).not.toBeInTheDocument();
});

test("AddAndSelectModel", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  fireEvent.change(page.getByLabelText("名称"), { target: { value: "example" } });
  fireEvent.change(page.getByLabelText("Base URL"), { target: { value: "https://models.example.test/v1" } });
  fireEvent.change(page.getByLabelText("API Key"), { target: { value: "storybook-placeholder" } });
  await waitFor(() => expect(page.getByLabelText("API Key")).toHaveValue("storybook-placeholder"));
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  await userEvent.click(page.getByRole("button", { name: "获取可用模型" }));
  await addFetchedModels();
  await waitFor(() => expect(page.getAllByRole("button", { name: /^配置 / })).toHaveLength(2));
  await waitFor(() => expect(page.getByRole("button", { name: "保存" })).toBeEnabled());
  await userEvent.click(page.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  const defaults = page.getAllByRole("button", { name: "deepseek / deepseek-chat" });
  await expect(defaults).toHaveLength(2);
  await userEvent.click(defaults[0]);
  await userEvent.click(page.getByRole("button", { name: "example / demo-text" }));
  await expect(page.getByRole("button", { name: "example / demo-text" })).toBeVisible();
});

test("ResponsesProtocol", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  await expect(page.getByText("Transport", { exact: true })).toBeVisible();
});

test("ContextOverrides", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="edit" />);
  const page = within(document.body);
  await userEvent.click(page.getAllByRole("button", { name: /^配置 / })[0]);
  await expect(within(page.getByRole("dialog")).getAllByRole("button", { name: "未设置" })[0]).toBeVisible();
  await userEvent.click(within(page.getByRole("dialog")).getAllByRole("button", { name: "未设置" })[0]);
  await userEvent.click(page.getByRole("button", { name: "256K" }));
  await expect(page.getByText(/上下文.*256.*tokens/)).toBeVisible();
});

test("DeleteProviderConfirmation", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="edit" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "删除" }));
  await expect(page.getByRole("button", { name: "确认删除" })).toBeVisible();
});

test("ImageValidationFailure", async () => {
  const { container: canvasElement } = render(<SettingsPreview initialTab="llm" operationFailure />);
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "未设置" }));
  await userEvent.click(within(document.body).getByRole("button", { name: "demo / demo-image" }));
  await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("该模型不支持图片生成"));
});

test("PresetConnection", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  await expect(page.getByLabelText("Base URL")).toHaveAttribute("readonly");
  await expect(page.getByRole("button", { name: "openai-completions" })).toBeDisabled();
  fireEvent.change(page.getByLabelText("API Key"), { target: { value: "storybook-placeholder" } });
  await userEvent.click(page.getByRole("button", { name: "获取可用模型" }));
  await addFetchedModels();
  await waitFor(() => expect(page.getAllByRole("button", { name: /^配置 / })).toHaveLength(2));
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
});

test("FetchingModels", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" modelFetch="loading" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "获取可用模型" }));
  await expect(page.getByRole("dialog", { name: "选择要添加的模型" })).toBeVisible();
  await expect(page.getByRole("status", { name: "加载模型" })).toBeVisible();
  await expect(page.queryByText("正在获取可用模型...")).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "获取可用模型" }));
  await expect(page.getByRole("status", { name: "加载模型" })).toBeVisible();
});

test("FetchModelsFailed", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" modelFetch="error" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "获取可用模型" }));
  await waitFor(() => expect(page.getByRole("alert")).toHaveTextContent("获取模型失败"));
  await expect(page.getByRole("button", { name: "重试" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(page.getByRole("alert")).toHaveTextContent("获取模型失败"));
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
});

test("NoModelsReturned", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" modelFetch="empty" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "获取可用模型" }));
  await waitFor(() => expect(page.getByRole("status")).toHaveTextContent("未获取到可用模型"));
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
});

test("ConnectionChangeRequiresFetch", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  fireEvent.change(page.getByLabelText("Base URL"), { target: { value: "https://new.example.test/v1" } });
  await expect(page.queryByRole("button", { name: /^配置 / })).not.toBeInTheDocument();
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  await userEvent.click(page.getByRole("button", { name: "获取可用模型" }));
  await addFetchedModels();
  await waitFor(() => expect(page.getAllByRole("button", { name: /^配置 / })).toHaveLength(2));
});

test("ModelContextFromApi", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" modelFetch="metadata" />);
  const page = within(document.body);
  fireEvent.change(page.getByLabelText("Base URL"), { target: { value: "https://new.example.test/v1" } });
  await userEvent.click(page.getByRole("button", { name: "获取可用模型" }));
  await addFetchedModels();
  await waitFor(() => expect(page.getByText(/上下文.*128.*tokens/)).toBeVisible());
  await expect(page.getByText("上下文窗口：未设置")).toBeVisible();
  await userEvent.click(within(page.getByRole("group", { name: "demo-text" })).getByRole("button", { name: /^配置 / }));
  await userEvent.click(page.getByRole("button", { name: /接口.*128.*tokens/ }));
  await userEvent.click(page.getByRole("button", { name: "256K" }));
  await userEvent.click(page.getByRole("button", { name: "获取可用模型" }));
  await waitFor(() => expect(page.getByRole("dialog", { name: "选择要添加的模型" })).toBeVisible());
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  await expect(page.getByRole("button", { name: "256K" })).toBeVisible();
});

test("ModelPicker", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  fireEvent.change(page.getByLabelText("Base URL"), { target: { value: "https://new.example.test/v1" } });
  await userEvent.click(page.getByRole("button", { name: "获取可用模型" }));
  await waitFor(() => expect(page.getByRole("textbox", { name: "搜索模型" })).toBeVisible());
  fireEvent.change(page.getByRole("textbox", { name: "搜索模型" }), { target: { value: "text" } });
  await waitFor(() => expect(page.getByRole("button", { name: "全选" })).toBeEnabled());
  await userEvent.click(page.getByRole("button", { name: "全选" }));
  fireEvent.change(page.getByRole("textbox", { name: "搜索模型" }), { target: { value: "" } });
  await expect(page.getByRole("checkbox", { name: "demo-text" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "demo-image" })).not.toBeChecked();
  const original = page.getByRole("dialog", { name: "", hidden: true });
  await expect(original).toHaveAttribute("inert");
  await userEvent.keyboard("{Escape}");
  await expect(page.getByRole("dialog", { name: "修改模型提供商" })).toBeVisible();
  await expect(page.getByLabelText("Base URL")).toHaveValue("https://new.example.test/v1");
  await userEvent.click(page.getByRole("button", { name: "获取可用模型" }));
  await waitFor(() => expect(page.getByRole("dialog", { name: "选择要添加的模型" })).toBeVisible());
  await waitFor(() => expect(page.getByRole("button", { name: "全选" })).toBeEnabled());
  await userEvent.click(page.getByRole("button", { name: "全选" }));
  await userEvent.keyboard("{Enter}");
  await expect(page.getByRole("dialog", { name: "修改模型提供商" })).toBeVisible();
  await expect(page.getAllByRole("button", { name: /^配置 / })).toHaveLength(2);
});

test("ManualModel", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: /手动添加模型/ }));
  fireEvent.change(page.getByLabelText("模型 ID"), { target: { value: "manual-model" } });
  await userEvent.click(page.getByRole("button", { name: "添加模型" }));
  const row = within(page.getByRole("group", { name: "manual-model" }));
  await userEvent.click(row.getByRole("checkbox", { name: "支持图片" }));
  await expect(row.queryByRole("checkbox", { name: "支持文本" })).not.toBeInTheDocument();
  await userEvent.click(row.getAllByRole("button", { name: "未设置" })[1]);
  await userEvent.click(page.getByRole("button", { name: "8K" }));
  await expect(row.getByRole("button", { name: "8K" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  await userEvent.click(page.getAllByRole("button", { name: "修改" })[1]);
  await userEvent.click(page.getByRole("button", { name: "配置 manual-model" }));
  const saved = within(page.getByRole("group", { name: "manual-model" }));
  await expect(saved.getByRole("checkbox", { name: "支持图片" })).toBeChecked();
  await expect(saved.queryByRole("checkbox", { name: "支持文本" })).not.toBeInTheDocument();
  await expect(saved.getByRole("button", { name: "8K" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "删除 manual-model" }));
  await expect(page.queryByRole("group", { name: "manual-model" })).not.toBeInTheDocument();
});

test("CustomMaxOutput", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="edit" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "配置 deepseek-chat" }));
  const row = within(page.getByRole("group", { name: "deepseek-chat" }));
  await userEvent.click(row.getAllByRole("button", { name: "未设置" })[1]);
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  const input = row.getByRole("textbox", { name: "自定义最大输出 token" });
  await expect(input).toHaveAttribute("inputmode", "numeric");
  await expect(row.queryByRole("spinbutton")).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: "12000" } });
  await expect(input).toHaveValue("12000");
  await userEvent.click(page.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  await userEvent.click(page.getAllByRole("button", { name: "修改" })[1]);
  await userEvent.click(page.getByRole("button", { name: "配置 deepseek-chat" }));
  const saved = within(page.getByRole("group", { name: "deepseek-chat" }));
  await expect(saved.getByRole("textbox", { name: "自定义最大输出 token" })).toHaveValue("12000");
  await userEvent.click(saved.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "64K" }));
  await expect(saved.getByRole("button", { name: "64K" })).toBeVisible();
  await expect(saved.queryByRole("textbox", { name: "自定义最大输出 token" })).not.toBeInTheDocument();
});

async function addFetchedModels() {
  const page = within(document.body);
  await waitFor(() => expect(page.getByRole("dialog", { name: "选择要添加的模型" })).toBeVisible());
  await waitFor(() => expect(page.getByRole("button", { name: "全选" })).toBeEnabled());
  await userEvent.click(page.getByRole("button", { name: "全选" }));
  await userEvent.click(page.getByRole("button", { name: /^添加（/ }));
}
