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
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  await expect(page.getByRole("switch", { name: "支持 WebSocket" })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
  await addFetchedModels();
  await waitFor(() => expect(page.getAllByRole("button", { name: /^编辑 / })).toHaveLength(2));
  await waitFor(() => expect(page.getByRole("button", { name: "保存" })).toBeEnabled());
  await userEvent.click(page.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  const defaultModel = page.getByRole("button", { name: "默认模型" });
  await expect(defaultModel).toHaveTextContent("deepseek / deepseek-chat");
  await expect(page.getByRole("button", { name: "deepseek / deepseek-chat" })).toBeVisible();
  await userEvent.click(defaultModel);
  await userEvent.click(page.getByRole("button", { name: "example / demo-text" }));
  await expect(defaultModel).toHaveTextContent("example / demo-text");
});

test("ResponsesProtocol", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  await expect(page.getByRole("switch", { name: "支持 WebSocket" })).toBeVisible();
});

test("ContextOverrides", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="edit" />);
  const page = within(document.body);
  await userEvent.click(page.getAllByRole("button", { name: /^编辑 / })[0]);
  await expect(within(page.getByRole("dialog")).getByRole("button", { name: "选择上下文窗口大小" })).toBeVisible();
  await userEvent.click(within(page.getByRole("dialog")).getByRole("button", { name: "选择上下文窗口大小" }));
  await userEvent.click(page.getByRole("button", { name: "256K" }));
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  await expect(page.getByText("上下文 256,000")).toBeVisible();
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
  await expect(page.getByRole("button", { name: "openai-completions" })).toBeEnabled();
  fireEvent.change(page.getByLabelText("API Key"), { target: { value: "storybook-placeholder" } });
  await waitFor(() => expect(page.getAllByRole("button", { name: /^编辑 / })).toHaveLength(2));
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
});

test("FetchingModels", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" modelFetch="loading" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
  await expect(page.getByRole("dialog", { name: "选择要添加的模型" })).toBeVisible();
  await expect(page.getByRole("status", { name: "加载模型" })).toBeVisible();
  await expect(page.queryByText("正在获取可用模型...")).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
  await expect(page.getByRole("status", { name: "加载模型" })).toBeVisible();
});

test("FetchModelsFailed", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" modelFetch="error" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
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
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
  await waitFor(() => expect(page.getByRole("status")).toHaveTextContent("未获取到可用模型"));
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
});

test("ConnectionChangesPreserveModels", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "编辑 demo-text" }));
  fireEvent.change(page.getByLabelText("模型名称（可选）"), { target: { value: "My text model" } });
  fireEvent.change(page.getByLabelText("上下文窗口大小"), { target: { value: "128000" } });
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  fireEvent.change(page.getByLabelText("Base URL"), { target: { value: "https://new.example.test/v1" } });
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await expect(page.getAllByRole("button", { name: /^编辑 / })).toHaveLength(2);
  await expect(page.getByText("My text model")).toBeVisible();
  await expect(page.getByText("上下文 128,000")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  await userEvent.click(page.getAllByRole("button", { name: "deepseek / deepseek-chat" })[0]);
  await expect(page.getByRole("button", { name: "demo / My text model" })).toBeVisible();
});

test("ModelContextFromApi", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" modelFetch="metadata" />);
  const page = within(document.body);
  fireEvent.change(page.getByLabelText("Base URL"), { target: { value: "https://new.example.test/v1" } });
  for (const id of ["demo-text", "demo-image"]) {
    await userEvent.click(page.getByRole("button", { name: `删除 ${id}` }));
    await userEvent.click(page.getByRole("button", { name: "确认删除" }));
  }
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
  await addFetchedModels();
  await waitFor(() => expect(page.getByText("上下文 128,000")).toBeVisible());
  await expect(page.queryByText("上下文 未设置")).not.toBeInTheDocument();
  await userEvent.click(within(page.getByRole("group", { name: "demo-text" })).getByRole("button", { name: /^编辑 / }));
  await userEvent.click(page.getByRole("button", { name: "选择上下文窗口大小" }));
  await userEvent.click(page.getByRole("button", { name: "256K" }));
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
  await waitFor(() => expect(page.getByRole("dialog", { name: "选择要添加的模型" })).toBeVisible());
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  await expect(page.getByText("上下文 256,000")).toBeVisible();
});

test("ModelPicker", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  fireEvent.change(page.getByLabelText("Base URL"), { target: { value: "https://new.example.test/v1" } });
  for (const id of ["demo-text", "demo-image"]) {
    await userEvent.click(page.getByRole("button", { name: `删除 ${id}` }));
    await userEvent.click(page.getByRole("button", { name: "确认删除" }));
  }
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
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
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
  await waitFor(() => expect(page.getByRole("dialog", { name: "选择要添加的模型" })).toBeVisible());
  await waitFor(() => expect(page.getByRole("button", { name: "全选" })).toBeEnabled());
  await userEvent.click(page.getByRole("button", { name: "全选" }));
  await userEvent.keyboard("{Enter}");
  await expect(page.getByRole("dialog", { name: "修改模型提供商" })).toBeVisible();
  await expect(page.getAllByRole("button", { name: /^编辑 / })).toHaveLength(2);
});

test("ManualModel", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "+ 添加模型" }));
  const dialog = within(page.getByRole("dialog", { name: "添加模型" }));
  await expect(dialog.getByRole("button", { name: "添加模型" })).toBeDisabled();
  fireEvent.change(dialog.getByLabelText("模型 ID"), { target: { value: "demo-text" } });
  await expect(dialog.getByRole("alert")).toHaveTextContent("该模型已添加");
  fireEvent.change(dialog.getByLabelText("模型 ID"), { target: { value: "manual-model" } });
  fireEvent.change(dialog.getByLabelText("模型名称（可选）"), { target: { value: "My Model" } });
  await userEvent.click(dialog.getByRole("checkbox", { name: "支持图片输入" }));
  await userEvent.click(dialog.getByRole("button", { name: "选择最大输出 token" }));
  await userEvent.click(page.getByRole("button", { name: "8K" }));
  await userEvent.keyboard("{Enter}");
  await expect(page.getByText("My Model")).toBeVisible();
  await expect(page.getByText("输出 8,192")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  await userEvent.click(page.getAllByRole("button", { name: "修改" })[1]);
  await userEvent.click(page.getByRole("button", { name: "编辑 manual-model" }));
  const saved = within(page.getByRole("dialog", { name: "编辑模型" }));
  await expect(saved.getByLabelText("模型名称（可选）")).toHaveValue("My Model");
  await expect(saved.getByRole("checkbox", { name: "支持图片输入" })).toBeChecked();
  await expect(saved.getByRole("textbox", { name: "最大输出 token" })).toHaveValue("8192");
  fireEvent.change(saved.getByLabelText("模型 ID"), { target: { value: "renamed-model" } });
  await userEvent.keyboard("{Escape}");
  await expect(page.getByRole("button", { name: "编辑 manual-model" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "编辑 manual-model" }));
  fireEvent.change(page.getByLabelText("模型 ID"), { target: { value: "renamed-model" } });
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  await expect(page.queryByRole("button", { name: "编辑 manual-model" })).not.toBeInTheDocument();
  await expect(page.getByRole("button", { name: "编辑 renamed-model" })).toBeVisible();
  await expect(page.getByText("输出 8,192")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "删除 renamed-model" }));
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  await expect(page.getByRole("group", { name: "renamed-model" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "删除 renamed-model" }));
  await userEvent.click(page.getByRole("button", { name: "确认删除" }));
  await expect(page.queryByRole("group", { name: "renamed-model" })).not.toBeInTheDocument();
});

test("CustomMaxOutput", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="edit" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "编辑 deepseek-chat" }));
  const row = within(page.getByRole("dialog", { name: "编辑模型" }));
  const input = row.getByRole("textbox", { name: "最大输出 token" });
  await expect(input).toHaveAttribute("inputmode", "numeric");
  await expect(row.queryByRole("spinbutton")).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: "12000" } });
  await expect(input).toHaveValue("12000");
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  await userEvent.click(page.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  await userEvent.click(page.getAllByRole("button", { name: "修改" })[1]);
  await userEvent.click(page.getByRole("button", { name: "编辑 deepseek-chat" }));
  const saved = within(page.getByRole("dialog", { name: "编辑模型" }));
  await expect(saved.getByRole("textbox", { name: "最大输出 token" })).toHaveValue("12000");
  await userEvent.click(saved.getByRole("button", { name: "选择最大输出 token" }));
  await userEvent.click(page.getByRole("button", { name: "64K" }));
  await expect(saved.getByRole("textbox", { name: "最大输出 token" })).toHaveValue("65536");
  fireEvent.change(saved.getByRole("textbox", { name: "最大输出 token" }), { target: { value: "" } });
  await expect(saved.getByRole("textbox", { name: "最大输出 token" })).toHaveValue("16384");
});

async function addFetchedModels() {
  const page = within(document.body);
  await waitFor(() => expect(page.getByRole("dialog", { name: "选择要添加的模型" })).toBeVisible());
  await waitFor(() => expect(page.getByRole("button", { name: "全选" })).toBeEnabled());
  await userEvent.click(page.getByRole("button", { name: "全选" }));
  await userEvent.click(page.getByRole("button", { name: /^添加（/ }));
}

test("EnvironmentKeyAndKeyRemovalPreserveModels", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  fireEvent.change(page.getByLabelText("API Key 环境变量名（优先使用）"), { target: { value: "TEST_API_KEY" } });
  fireEvent.change(page.getByLabelText("API Key", { exact: true }), { target: { value: "preview-key" } });
  await expect(page.getByRole("button", { name: "编辑 demo-text" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "清除已保存的 API Key" }));
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  await userEvent.click(page.getAllByRole("button", { name: "修改" })[1]);
  await expect(page.getByLabelText("API Key 环境变量名（优先使用）")).toHaveValue("TEST_API_KEY");
  await expect(page.queryByRole("button", { name: "清除已保存的 API Key" })).not.toBeInTheDocument();
  await expect(page.getByRole("button", { name: "编辑 demo-text" })).toBeVisible();
});

test("UnsupportedPresetsAndCredentialProtocolsHidden", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  for (const name of [/Codex/, /Bedrock/, /Vertex/, /Cloudflare/, /Azure/]) {
    await expect(page.queryByRole("button", { name })).not.toBeInTheDocument();
  }
  await userEvent.click(page.getByRole("button", { name: "Mistral" }));
  await expect(page.getByLabelText("Base URL")).toHaveAttribute("readonly");
  await expect(page.getByRole("button", { name: "mistral-conversations" })).toBeDisabled();
  await userEvent.click(page.getByRole("button", { name: "Mistral" }));
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  for (const name of ["openai-completions", "openai-responses", "anthropic-messages"]) {
    for (const button of page.getAllByRole("button", { name })) {
      await expect(button).toBeVisible();
    }
  }
  for (const name of [
    "pi-messages",
    "azure-openai-responses",
    "google-generative-ai",
    "mistral-conversations",
    "openai-codex-responses",
    "bedrock-converse-stream",
    "google-vertex",
  ]) {
    await expect(page.queryByRole("button", { name })).not.toBeInTheDocument();
  }
});

test("PresetAppearsOnceAndProtocolSelectsItsFixedUrl", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await expect(page.getAllByRole("button", { name: /Fireworks/ })).toHaveLength(1);
  await userEvent.click(page.getByRole("button", { name: "Fireworks" }));
  await expect(page.getByLabelText("Base URL")).toHaveValue("https://api.fireworks.ai/inference");
  await expect(page.getByLabelText("Base URL")).toHaveAttribute("readonly");
  await userEvent.click(page.getByRole("button", { name: "anthropic-messages" }));
  await expect(page.queryByRole("button", { name: "google-vertex" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await expect(page.getByLabelText("Base URL")).toHaveValue("https://api.fireworks.ai/inference/v1");
  await userEvent.click(page.getByRole("button", { name: "Fireworks" }));
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await expect(page.getByLabelText("Base URL")).not.toHaveAttribute("readonly");
});

test("PresetFillsEnvironmentNameBeforeApiKeyAndCustomClearsIt", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  const environment = page.getByLabelText("API Key 环境变量名（优先使用）");
  await expect(environment).toHaveValue("DEEPSEEK_API_KEY");
  expect(environment.compareDocumentPosition(page.getByLabelText("API Key", { exact: true }))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  fireEvent.change(environment, { target: { value: "MY_KEY" } });
  await expect(environment).toHaveValue("MY_KEY");
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await expect(environment).toHaveValue("");
});

test("DeepSeekResponsesUsesHttpAndProtocolSpecificUrls", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "anthropic-messages" }));
  await expect(page.getByLabelText("Base URL")).toHaveValue("https://api.deepseek.com/anthropic");
  await userEvent.click(page.getByRole("button", { name: "anthropic-messages" }));
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  await expect(page.getByLabelText("Base URL")).toHaveValue("https://api.deepseek.com");
  await expect(page.getByRole("switch", { name: "支持 WebSocket" })).not.toBeChecked();
  await expect(page.queryByRole("button", { name: /优先 WebSocket/ })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  await expect(page.getByRole("switch", { name: "支持 WebSocket" })).not.toBeChecked();
});

test("DeepSeekPresetIncludesCurrentModelsWithoutFetching", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  await expect(page.getByText("DeepSeek-V4.1-Flash")).toBeVisible();
  await expect(page.getByText("DeepSeek-V4-Pro")).toBeVisible();
  const collapsed = within(page.getByRole("group", { name: "deepseek-flash" }));
  await expect(collapsed.getByText("多模态")).toBeVisible();
  await expect(collapsed.getByText("深度思考")).toBeVisible();
  await expect(collapsed.getByText("上下文 1,000,000")).toBeVisible();
  await expect(collapsed.getByText("输出 256,000")).toBeVisible();
  await expect(
    within(page.getByRole("group", { name: "deepseek-v4-pro" })).queryByText("多模态"),
  ).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "编辑 deepseek-flash" }));
  const row = within(page.getByRole("dialog", { name: "编辑模型" }));
  await expect(row.queryByText("多模态")).not.toBeInTheDocument();
  await expect(row.getByRole("checkbox", { name: "支持图片输入" })).toBeChecked();
  await expect(row.getByRole("textbox", { name: "上下文窗口大小" })).toHaveValue("1000000");
  await userEvent.click(row.getByRole("button", { name: "选择上下文窗口大小" }));
  await expect(page.getAllByRole("button", { name: "1M" })).toHaveLength(1);
  await userEvent.click(page.getByRole("button", { name: "192K" }));
  await expect(row.getByRole("textbox", { name: "上下文窗口大小" })).toHaveValue("192000");
  await expect(row.getByRole("textbox", { name: "最大输出 token" })).toHaveValue("256000");
  await userEvent.click(row.getByRole("button", { name: "选择最大输出 token" }));
  await userEvent.click(page.getByRole("button", { name: "64K" }));
  await userEvent.click(row.getByRole("button", { name: "选择最大输出 token" }));
  await userEvent.click(page.getByRole("button", { name: "256K" }));
  await expect(row.getByRole("textbox", { name: "最大输出 token" })).toHaveValue("256000");
  await expect(page.getByRole("button", { name: "保存模型" })).toBeDisabled();
  fireEvent.change(row.getByRole("textbox", { name: "上下文窗口大小" }), { target: { value: "1000000" } });
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  await expect(page.getByRole("button", { name: "编辑 deepseek-v4-pro" })).toBeVisible();
});

test("ProviderNamesAreEditableAndUnique", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="edit" />);
  const page = within(document.body);
  const name = page.getByLabelText("名称", { exact: true });
  await expect(name).not.toHaveAttribute("readonly");
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
  fireEvent.change(name, { target: { value: "  demo  " } });
  await expect(page.getByText("提供方名称已存在")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  fireEvent.change(name, { target: { value: "   " } });
  await expect(page.getByText("请输入提供方名称")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  fireEvent.change(name, { target: { value: "  我的 DeepSeek  " } });
  await userEvent.click(page.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(page.queryByRole("dialog")).not.toBeInTheDocument());
  await expect(page.getByText("我的 DeepSeek", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "默认模型" })).toHaveTextContent("我的 DeepSeek / deepseek-chat");
  await expect(page.getByRole("button", { name: "我的 DeepSeek / deepseek-chat" })).toBeVisible();
  await userEvent.click(page.getAllByRole("button", { name: "修改" })[1]);
  await expect(page.getByLabelText("名称", { exact: true })).toHaveValue("我的 DeepSeek");
  await expect(page.getByRole("button", { name: "编辑 deepseek-chat" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
});

test("NewPresetProviderCannotReuseAnExistingName", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  const name = page.getByLabelText("名称", { exact: true });
  await expect(name).not.toHaveAttribute("readonly");
  fireEvent.change(name, { target: { value: "deepseek" } });
  await expect(page.getByText("提供方名称已存在")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();
  fireEvent.change(name, { target: { value: "DeepSeek 公司" } });
  await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
});

test("ModelMenuConsumesEscapeAndEnterBeforeDialog", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="edit" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "编辑 deepseek-chat" }));
  await userEvent.click(page.getByRole("button", { name: "选择上下文窗口大小" }));
  await userEvent.keyboard("{Escape}");
  await expect(page.getByRole("dialog", { name: "编辑模型" })).toBeVisible();
  await expect(page.queryByRole("button", { name: "192K" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "选择上下文窗口大小" }));
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect(page.getByLabelText("上下文窗口大小")).toHaveValue("256000");
  await expect(page.getByRole("dialog", { name: "编辑模型" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect(page.getByRole("dialog", { name: "修改模型提供商" })).toBeVisible();
});

test("ModelReasoningAndHeaders", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  await userEvent.click(page.getByRole("button", { name: "编辑 deepseek-flash" }));
  await expect(page.getByRole("button", { name: "思考强度" })).toHaveTextContent("关闭 / 低 / 高 / 最高");
  await userEvent.click(page.getByRole("button", { name: "+ 添加" }));
  fireEvent.change(page.getByLabelText("Header 1 Value"), { target: { value: "preview" } });
  await expect(page.getByRole("button", { name: "保存模型" })).toBeDisabled();
  fireEvent.change(page.getByLabelText("Header 1 Key"), { target: { value: "X-Test" } });
  await userEvent.click(page.getByRole("button", { name: "+ 添加" }));
  fireEvent.change(page.getByLabelText("Header 2 Key"), { target: { value: "x-test" } });
  await expect(page.getByRole("button", { name: "保存模型" })).toBeDisabled();
  fireEvent.change(page.getByLabelText("Header 2 Key"), { target: { value: "X-Other" } });
  fireEvent.change(page.getByLabelText("Header 2 Value"), { target: { value: "second" } });
  await userEvent.click(page.getByRole("button", { name: "思考强度" }));
  await userEvent.click(page.getByRole("button", { name: "不支持推理" }));
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  await userEvent.click(page.getByRole("button", { name: "编辑 deepseek-flash" }));
  await expect(page.getByRole("button", { name: "思考强度" })).toHaveTextContent("不支持推理");
  await expect(page.getByLabelText("Header 1 Key")).toHaveValue("X-Test");
  await expect(page.getByLabelText("Header 1 Value")).toHaveValue("preview");
  await expect(page.getByLabelText("Header 2 Value")).toHaveValue("second");
  await userEvent.click(page.getByRole("button", { name: "删除 Header 1" }));
  await expect(page.getByLabelText("Header 1 Key")).toHaveValue("X-Other");
  await userEvent.click(page.getByRole("button", { name: "删除 Header 1" }));
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  await userEvent.click(page.getByRole("button", { name: "编辑 deepseek-flash" }));
  await expect(page.queryByLabelText("Header 1 Key")).not.toBeInTheDocument();
});

test("ThinkingPresetRoundTrip", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "编辑 demo-text" }));
  await expect(page.getByRole("button", { name: "思考强度" })).toHaveTextContent("不支持推理");
  await userEvent.click(page.getByRole("button", { name: "思考强度" }));
  await expect(page.queryByRole("button", { name: "自动适配" })).not.toBeInTheDocument();
  await expect(page.queryByRole("button", { name: "模型原有映射" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "低 / 中 / 高" }));
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  await userEvent.click(page.getByRole("button", { name: "编辑 demo-text" }));
  await expect(page.getByRole("button", { name: "思考强度" })).toHaveTextContent("低 / 中 / 高");
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  await expect(within(page.getByRole("group", { name: "demo-text" })).getByText("深度思考")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "编辑 demo-text" }));
  await userEvent.click(page.getByRole("button", { name: "思考强度" }));
  await userEvent.click(page.getByRole("button", { name: "不支持推理" }));
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  await expect(within(page.getByRole("group", { name: "demo-text" })).queryByText("深度思考")).not.toBeInTheDocument();
});

test("DeepSeekModelsUseDifferentThinkingMaps", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  await userEvent.click(page.getByRole("button", { name: "编辑 deepseek-flash" }));
  await expect(page.getByRole("button", { name: "思考强度" })).toHaveTextContent("关闭 / 低 / 高 / 最高");
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  await userEvent.click(page.getByRole("button", { name: "编辑 deepseek-v4-pro" }));
  await expect(page.getByRole("button", { name: "思考强度" })).toHaveTextContent("关闭 / 高 / 最高");
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  await userEvent.click(page.getByRole("button", { name: "编辑 deepseek-v4-pro" }));
  await expect(page.getByRole("button", { name: "思考强度" })).toHaveTextContent("关闭 / 高 / 最高");
});
