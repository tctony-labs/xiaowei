import { act, cleanup, configure, fireEvent, getConfig, render, within } from "@testing-library/react";
import userEventApi from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SettingsPreview } from "./SettingsPreview";

let userEvent: ReturnType<typeof userEventApi.setup>;
const defaultAsyncWrapper = getConfig().asyncWrapper;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // RTL drains async work through a zero-delay timer that Vitest does not advance automatically.
  configure({ asyncWrapper: async (callback) => act(callback) });
  userEvent = userEventApi.setup({ advanceTimers: vi.advanceTimersByTime });
});

afterEach(() => {
  cleanup();
  configure({ asyncWrapper: defaultAsyncWrapper });
  vi.useRealTimers();
});

async function advanceTime(milliseconds: number) {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
}

test("SaveFailure", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="edit" operationFailure />);
  const page = within(document.body);
  const provider = within(page.getByRole("dialog", { name: "修改模型提供商" }));
  const save = provider.getByRole("button", { name: "保存" });
  await userEvent.click(save);
  expect(save).toHaveTextContent("保存中...");
  expect(save).toBeDisabled();
  await advanceTime(349);
  expect(provider.queryByRole("alert")).not.toBeInTheDocument();
  expect(save).toBeDisabled();
  await advanceTime(1);
  expect(provider.getByRole("alert")).toHaveTextContent("操作失败");
  expect(page.getByRole("dialog", { name: "修改模型提供商" })).toBeVisible();
});

test("DeleteProviderRequiresConfirmation", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  const provider = within(page.getByRole("dialog", { name: "修改模型提供商" }));
  await userEvent.click(provider.getByRole("button", { name: "删除" }));
  expect(provider.getByRole("button", { name: "确认删除" })).toBeVisible();
  await userEvent.click(provider.getByRole("button", { name: "取消" }));
  expect(page.queryByRole("dialog")).not.toBeInTheDocument();
  expect(page.getByText("demo", { exact: true })).toBeVisible();

  await userEvent.click(page.getAllByRole("button", { name: "修改" })[1]);
  const reopened = within(page.getByRole("dialog", { name: "修改模型提供商" }));
  await userEvent.click(reopened.getByRole("button", { name: "删除" }));
  await userEvent.click(reopened.getByRole("button", { name: "确认删除" }));
  await advanceTime(350);
  expect(page.queryByRole("dialog")).not.toBeInTheDocument();
  expect(page.queryByText("demo", { exact: true })).not.toBeInTheDocument();
  expect(page.getByRole("button", { name: "默认模型" })).toHaveTextContent("deepseek/deepseek-chat");
});

test("AddAndSelectModel", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  const provider = within(page.getByRole("dialog", { name: "添加模型提供商" }));
  fireEvent.change(provider.getByLabelText("名称"), { target: { value: "example" } });
  fireEvent.change(provider.getByLabelText("Base URL"), { target: { value: "https://models.example.test/v1" } });
  fireEvent.change(provider.getByLabelText("API Key"), { target: { value: "storybook-placeholder" } });
  expect(provider.getByRole("button", { name: "保存" })).toBeEnabled();
  await userEvent.click(provider.getByRole("button", { name: "导入模型" }));
  await addFetchedModels();
  expect(provider.getAllByRole("button", { name: /^编辑 / })).toHaveLength(2);
  await userEvent.click(provider.getByRole("button", { name: "保存" }));
  await advanceTime(350);
  expect(page.queryByRole("dialog")).not.toBeInTheDocument();
  const defaultModel = page.getByRole("button", { name: "默认模型" });
  expect(defaultModel).toHaveTextContent("deepseek/deepseek-chat");
  expect(page.getByRole("button", { name: "deepseek/deepseek-chat" })).toBeVisible();
  await userEvent.click(defaultModel);
  await userEvent.click(page.getByRole("button", { name: "example/demo-text" }));
  expect(defaultModel).toHaveTextContent("example/demo-text");
});

test("ImageValidationFailure", async () => {
  const { container: canvasElement } = render(<SettingsPreview initialTab="llm" operationFailure />);
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "未设置" }));
  await userEvent.click(within(document.body).getByRole("button", { name: "demo/demo-image" }));
  await advanceTime(350);
  expect(canvas.getByRole("status")).toHaveTextContent("该模型不支持图片生成");
});

test("FetchingModels", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" modelFetch="loading" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
  expect(page.getByRole("dialog", { name: "选择要添加的模型" })).toBeVisible();
  expect(page.getByRole("status", { name: "加载模型" })).toBeVisible();
  expect(page.queryByText("正在获取可用模型...")).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
  expect(page.getByRole("status", { name: "加载模型" })).toBeVisible();
});

test("FetchModelsFailed", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" modelFetch="error" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
  await advanceTime(350);
  expect(page.getByRole("alert")).toHaveTextContent("获取模型失败");
  expect(page.getByRole("button", { name: "重试" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "重试" }));
  await advanceTime(350);
  expect(page.getByRole("alert")).toHaveTextContent("获取模型失败");
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
});

test("NoModelsReturned", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" modelFetch="empty" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
  await advanceTime(350);
  expect(page.getByRole("status")).toHaveTextContent("未获取到可用模型");
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
});

test("ConnectionChangesPreserveModels", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  const provider = within(page.getByRole("dialog", { name: "修改模型提供商" }));
  await userEvent.click(provider.getByRole("button", { name: "编辑 demo-text" }));
  const model = within(page.getByRole("dialog", { name: "编辑模型" }));
  fireEvent.change(model.getByLabelText("模型名称（可选）"), { target: { value: "My text model" } });
  fireEvent.change(model.getByLabelText("上下文窗口大小"), { target: { value: "128000" } });
  await userEvent.click(model.getByRole("button", { name: "保存模型" }));
  fireEvent.change(provider.getByLabelText("Base URL"), { target: { value: "https://new.example.test/v1" } });
  expect(provider.getByRole("switch", { name: "支持 WebSocket" })).toBeVisible();
  await userEvent.click(provider.getByRole("button", { name: "openai-responses" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  expect(provider.getAllByRole("button", { name: /^编辑 / })).toHaveLength(2);
  expect(provider.getByText("My text model")).toBeVisible();
  expect(provider.getByText("上下文 128,000")).toBeVisible();
  expect(provider.getByRole("button", { name: "保存" })).toBeEnabled();
  await userEvent.click(provider.getByRole("button", { name: "保存" }));
  await advanceTime(350);
  expect(page.queryByRole("dialog")).not.toBeInTheDocument();
  await userEvent.click(page.getAllByRole("button", { name: "deepseek/deepseek-chat" })[0]);
  expect(page.getByRole("button", { name: "demo/My text model" })).toBeVisible();
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
  expect(page.getByText("上下文 128,000")).toBeVisible();
  expect(page.queryByText("上下文 未设置")).not.toBeInTheDocument();
  await userEvent.click(within(page.getByRole("group", { name: "demo-text" })).getByRole("button", { name: /^编辑 / }));
  await userEvent.click(page.getByRole("button", { name: "选择上下文窗口大小" }));
  await userEvent.click(page.getByRole("button", { name: "256K" }));
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
  expect(page.getByRole("dialog", { name: "选择要添加的模型" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  expect(page.getByText("上下文 256,000")).toBeVisible();
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
  await advanceTime(350);
  expect(page.getByRole("textbox", { name: "搜索模型" })).toBeVisible();
  fireEvent.change(page.getByRole("textbox", { name: "搜索模型" }), { target: { value: "text" } });
  expect(page.getByRole("button", { name: "全选" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "全选" }));
  fireEvent.change(page.getByRole("textbox", { name: "搜索模型" }), { target: { value: "" } });
  expect(page.getByRole("checkbox", { name: "demo-text" })).toBeChecked();
  expect(page.getByRole("checkbox", { name: "demo-image" })).not.toBeChecked();
  const original = page.getByRole("dialog", { name: "", hidden: true });
  expect(original).toHaveAttribute("inert");
  await userEvent.keyboard("{Escape}");
  expect(page.getByRole("dialog", { name: "修改模型提供商" })).toBeVisible();
  expect(page.getByLabelText("Base URL")).toHaveValue("https://new.example.test/v1");
  await userEvent.click(page.getByRole("button", { name: "导入模型" }));
  expect(page.getByRole("dialog", { name: "选择要添加的模型" })).toBeVisible();
  expect(page.getByRole("status", { name: "加载模型" })).toBeVisible();
  await advanceTime(349);
  expect(page.getByRole("status", { name: "加载模型" })).toBeVisible();
  await advanceTime(1);
  expect(page.queryByRole("status", { name: "加载模型" })).not.toBeInTheDocument();
  expect(page.getByRole("button", { name: "全选" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "全选" }));
  await userEvent.keyboard("{Enter}");
  expect(page.getByRole("dialog", { name: "修改模型提供商" })).toBeVisible();
  expect(page.getAllByRole("button", { name: /^编辑 / })).toHaveLength(2);
});

test("ManualModel", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "+ 添加模型" }));
  const dialog = within(page.getByRole("dialog", { name: "添加模型" }));
  const context = dialog.getByLabelText("上下文窗口大小");
  const output = dialog.getByLabelText("最大输出 token");
  expect(dialog.getByRole("button", { name: "添加模型" })).toBeDisabled();
  expect(context).toHaveValue("");
  expect(context).toHaveAttribute("placeholder", "256000");
  expect(output).toHaveValue("");
  expect(output).toHaveAttribute("placeholder", "32768");
  fireEvent.change(dialog.getByLabelText("模型 ID"), { target: { value: "demo-text" } });
  expect(dialog.getByRole("alert")).toHaveTextContent("该模型已添加");
  fireEvent.change(dialog.getByLabelText("模型 ID"), { target: { value: "manual-model" } });
  fireEvent.change(dialog.getByLabelText("模型名称（可选）"), { target: { value: "My Model" } });
  await userEvent.click(dialog.getByRole("checkbox", { name: "支持图片输入" }));
  expect(output).toHaveAttribute("inputmode", "numeric");
  expect(dialog.queryByRole("spinbutton")).not.toBeInTheDocument();
  fireEvent.change(output, { target: { value: "12000" } });
  await userEvent.keyboard("{Enter}");

  expect(page.getByText("My Model")).toBeVisible();
  expect(page.getByText("输出 12,000")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "保存" }));
  await advanceTime(350);
  expect(page.queryByRole("dialog")).not.toBeInTheDocument();

  await userEvent.click(page.getAllByRole("button", { name: "修改" })[1]);
  await userEvent.click(page.getByRole("button", { name: "编辑 manual-model" }));
  const saved = within(page.getByRole("dialog", { name: "编辑模型" }));
  const savedContext = saved.getByLabelText("上下文窗口大小");
  const savedOutput = saved.getByLabelText("最大输出 token");
  expect(savedContext).toHaveValue("");
  expect(savedContext).toHaveAttribute("placeholder", "256000");
  expect(saved.getByLabelText("模型名称（可选）")).toHaveValue("My Model");
  expect(saved.getByRole("checkbox", { name: "支持图片输入" })).toBeChecked();
  expect(savedOutput).toHaveValue("12000");
  await userEvent.click(saved.getByRole("button", { name: "选择最大输出 token" }));
  await userEvent.click(page.getByRole("button", { name: "64K" }));
  expect(savedOutput).toHaveValue("65536");
  fireEvent.change(savedOutput, { target: { value: "" } });
  expect(savedOutput).toHaveValue("");
  expect(savedOutput).toHaveAttribute("placeholder", "32768");
  fireEvent.change(saved.getByLabelText("模型 ID"), { target: { value: "renamed-model" } });
  await userEvent.keyboard("{Escape}");
  expect(page.getByRole("button", { name: "编辑 manual-model" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "编辑 manual-model" }));
  fireEvent.change(page.getByLabelText("模型 ID"), { target: { value: "renamed-model" } });
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  expect(page.queryByRole("button", { name: "编辑 manual-model" })).not.toBeInTheDocument();
  expect(page.getByRole("button", { name: "编辑 renamed-model" })).toBeVisible();
  expect(page.getByText("输出 12,000")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "删除 renamed-model" }));
  await userEvent.click(page.getByRole("button", { name: "取消" }));
  expect(page.getByRole("group", { name: "renamed-model" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "删除 renamed-model" }));
  await userEvent.click(page.getByRole("button", { name: "确认删除" }));
  expect(page.queryByRole("group", { name: "renamed-model" })).not.toBeInTheDocument();
});

async function addFetchedModels() {
  const page = within(document.body);
  const dialog = page.getByRole("dialog", { name: "选择要添加的模型" });
  const picker = within(dialog);
  expect(dialog).toBeVisible();
  const loading = picker.getByRole("status", { name: "加载模型" });
  expect(loading).toBeVisible();
  await advanceTime(349);
  expect(loading).toBeVisible();
  await advanceTime(1);
  expect(picker.queryByRole("status", { name: "加载模型" })).not.toBeInTheDocument();
  await userEvent.click(picker.getByRole("button", { name: "全选" }));
  await userEvent.click(picker.getByRole("button", { name: /^添加（/ }));
}

test("EnvironmentKeyAndKeyRemovalPreserveModels", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  fireEvent.change(page.getByLabelText("API Key 环境变量名（优先使用）"), { target: { value: "TEST_API_KEY" } });
  fireEvent.change(page.getByLabelText("API Key", { exact: true }), { target: { value: "preview-key" } });
  expect(page.getByRole("button", { name: "编辑 demo-text" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "清除已保存的 API Key" }));
  expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
  await userEvent.click(page.getByRole("button", { name: "保存" }));
  await advanceTime(350);
  expect(page.queryByRole("dialog")).not.toBeInTheDocument();

  await userEvent.click(page.getAllByRole("button", { name: "修改" })[1]);
  expect(page.getByLabelText("API Key 环境变量名（优先使用）")).toHaveValue("TEST_API_KEY");
  expect(page.queryByRole("button", { name: "清除已保存的 API Key" })).not.toBeInTheDocument();
  expect(page.getByRole("button", { name: "编辑 demo-text" })).toBeVisible();
});

test("UnsupportedPresetsAndCredentialProtocolsHidden", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  const provider = within(page.getByRole("dialog", { name: "添加模型提供商" }));
  await userEvent.click(provider.getByRole("button", { name: "自定义" }));
  for (const name of [/Codex/, /Bedrock/, /Vertex/, /Cloudflare/, /Azure/]) {
    expect(page.queryByRole("button", { name })).not.toBeInTheDocument();
  }
  await userEvent.click(page.getByRole("button", { name: "Mistral" }));
  expect(provider.getByLabelText("Base URL")).toHaveAttribute("readonly");
  expect(page.getByRole("button", { name: "mistral-conversations" })).toBeDisabled();
  await userEvent.click(page.getByRole("button", { name: "Mistral" }));
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await userEvent.click(provider.getByRole("button", { name: "openai-completions" }));
  for (const name of ["openai-completions", "openai-responses", "anthropic-messages"]) {
    for (const button of page.getAllByRole("button", { name })) {
      expect(button).toBeVisible();
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
    expect(page.queryByRole("button", { name })).not.toBeInTheDocument();
  }
});

test("PresetAppearsOnceAndProtocolSelectsItsFixedUrl", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  const provider = within(page.getByRole("dialog", { name: "添加模型提供商" }));
  await userEvent.click(provider.getByRole("button", { name: "自定义" }));
  expect(page.getAllByRole("button", { name: /Fireworks/ })).toHaveLength(1);
  await userEvent.click(page.getByRole("button", { name: "Fireworks" }));
  expect(provider.getByLabelText("Base URL")).toHaveValue("https://api.fireworks.ai/inference");
  expect(provider.getByLabelText("Base URL")).toHaveAttribute("readonly");
  await userEvent.click(page.getByRole("button", { name: "anthropic-messages" }));
  expect(page.queryByRole("button", { name: "google-vertex" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  expect(provider.getByLabelText("Base URL")).toHaveValue("https://api.fireworks.ai/inference/v1");
  await userEvent.click(page.getByRole("button", { name: "Fireworks" }));
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  expect(provider.getByLabelText("Base URL")).not.toHaveAttribute("readonly");
});

test("PresetDefaultsAndCustomReset", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  const provider = within(page.getByRole("dialog", { name: "添加模型提供商" }));
  await userEvent.click(provider.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  const url = provider.getByLabelText("Base URL");
  expect(url).toHaveAttribute("readonly");
  expect(provider.getByRole("button", { name: "openai-completions" })).toBeEnabled();
  expect(provider.getAllByRole("button", { name: /^编辑 / })).toHaveLength(2);
  fireEvent.change(provider.getByLabelText("API Key", { exact: true }), { target: { value: "storybook-placeholder" } });
  const name = provider.getByLabelText("名称", { exact: true });
  expect(name).not.toHaveAttribute("readonly");
  fireEvent.change(name, { target: { value: "deepseek" } });
  expect(provider.getByText("提供方名称已存在")).toBeVisible();
  expect(provider.getByRole("button", { name: "保存" })).toBeDisabled();
  fireEvent.change(name, { target: { value: "DeepSeek 公司" } });
  expect(provider.getByRole("button", { name: "保存" })).toBeEnabled();
  const environment = provider.getByLabelText("API Key 环境变量名（优先使用）");
  expect(environment).toHaveValue("DEEPSEEK_API_KEY");
  expect(environment.compareDocumentPosition(provider.getByLabelText("API Key", { exact: true }))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  fireEvent.change(environment, { target: { value: "MY_KEY" } });
  expect(environment).toHaveValue("MY_KEY");
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  expect(environment).toHaveValue("");
  expect(url).not.toHaveAttribute("readonly");
  expect(page.getByRole("button", { name: "openai-completions" })).toBeEnabled();
});

test("DeepSeekResponsesUsesHttpAndProtocolSpecificUrls", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  const provider = within(page.getByRole("dialog", { name: "添加模型提供商" }));
  await userEvent.click(provider.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  await userEvent.click(provider.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "anthropic-messages" }));
  expect(provider.getByLabelText("Base URL")).toHaveValue("https://api.deepseek.com/anthropic");
  await userEvent.click(page.getByRole("button", { name: "anthropic-messages" }));
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  expect(provider.getByLabelText("Base URL")).toHaveValue("https://api.deepseek.com");
  expect(provider.getByRole("switch", { name: "支持 WebSocket" })).not.toBeChecked();
  expect(page.queryByRole("button", { name: /优先 WebSocket/ })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  await userEvent.click(page.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  expect(provider.getByRole("switch", { name: "支持 WebSocket" })).not.toBeChecked();
});

test("DeepSeekPresetIncludesCurrentModelsWithoutFetching", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="add" />);
  const page = within(document.body);
  const provider = within(page.getByRole("dialog", { name: "添加模型提供商" }));
  await userEvent.click(provider.getByRole("button", { name: "自定义" }));
  await userEvent.click(page.getByRole("button", { name: "DeepSeek" }));
  expect(page.getByText("DeepSeek-V4.1-Flash")).toBeVisible();
  expect(page.getByText("DeepSeek-V4-Pro")).toBeVisible();
  const collapsed = within(provider.getByRole("group", { name: "deepseek-flash" }));
  expect(collapsed.getByText("多模态")).toBeVisible();
  expect(collapsed.getByText("深度思考")).toBeVisible();
  expect(collapsed.getByText("上下文 1,000,000")).toBeVisible();
  expect(collapsed.getByText("输出 256,000")).toBeVisible();
  expect(
    within(provider.getByRole("group", { name: "deepseek-v4-pro" })).queryByText("多模态"),
  ).not.toBeInTheDocument();
  await userEvent.click(provider.getByRole("button", { name: "编辑 deepseek-flash" }));
  const row = within(page.getByRole("dialog", { name: "编辑模型" }));
  expect(row.getByRole("button", { name: "深度思考" })).toHaveTextContent("关闭 / 低 / 高 / 最高");
  expect(row.queryByText("多模态")).not.toBeInTheDocument();
  expect(row.getByRole("checkbox", { name: "支持图片输入" })).toBeChecked();
  expect(row.getByLabelText("上下文窗口大小")).toHaveValue("1000000");
  await userEvent.click(row.getByRole("button", { name: "选择上下文窗口大小" }));
  expect(page.getAllByRole("button", { name: "1M" })).toHaveLength(1);
  await userEvent.click(page.getByRole("button", { name: "192K" }));
  expect(row.getByLabelText("上下文窗口大小")).toHaveValue("192000");
  expect(row.getByLabelText("最大输出 token")).toHaveValue("256000");
  await userEvent.click(row.getByRole("button", { name: "选择最大输出 token" }));
  await userEvent.click(page.getByRole("button", { name: "64K" }));
  await userEvent.click(row.getByRole("button", { name: "选择最大输出 token" }));
  await userEvent.click(page.getByRole("button", { name: "256K" }));
  expect(row.getByLabelText("最大输出 token")).toHaveValue("256000");
  expect(page.getByRole("button", { name: "保存模型" })).toBeDisabled();
  fireEvent.change(row.getByLabelText("上下文窗口大小"), { target: { value: "1000000" } });
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  await userEvent.click(provider.getByRole("button", { name: "openai-completions" }));
  await userEvent.click(page.getByRole("button", { name: "openai-responses" }));
  expect(provider.getByRole("button", { name: "编辑 deepseek-v4-pro" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "编辑 deepseek-v4-pro" }));
  const pro = within(page.getByRole("dialog", { name: "编辑模型" }));
  expect(pro.getByRole("button", { name: "深度思考" })).toHaveTextContent("关闭 / 高 / 最高");
});

test("ProviderNamesAreEditableAndUnique", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="edit" />);
  const page = within(document.body);
  const provider = within(page.getByRole("dialog", { name: "修改模型提供商" }));
  const name = provider.getByLabelText("名称", { exact: true });
  expect(name).not.toHaveAttribute("readonly");
  expect(provider.getByRole("button", { name: "保存" })).toBeEnabled();
  fireEvent.change(name, { target: { value: "  demo  " } });
  expect(provider.getByText("提供方名称已存在")).toBeVisible();
  expect(provider.getByRole("button", { name: "保存" })).toBeDisabled();
  fireEvent.change(name, { target: { value: "   " } });
  expect(provider.getByText("请输入提供方名称")).toBeVisible();
  expect(provider.getByRole("button", { name: "保存" })).toBeDisabled();
  fireEvent.change(name, { target: { value: "  我的 DeepSeek  " } });
  await userEvent.click(provider.getByRole("button", { name: "保存" }));
  await advanceTime(350);
  expect(page.queryByRole("dialog")).not.toBeInTheDocument();
  expect(page.getByText("我的 DeepSeek", { exact: true })).toBeVisible();
  expect(page.getByRole("button", { name: "默认模型" })).toHaveTextContent("我的 DeepSeek/deepseek-chat");
  expect(page.getByRole("button", { name: "我的 DeepSeek/deepseek-chat" })).toBeVisible();

  await userEvent.click(page.getAllByRole("button", { name: "修改" })[1]);
  expect(page.getByLabelText("名称", { exact: true })).toHaveValue("我的 DeepSeek");
  expect(page.getByRole("button", { name: "编辑 deepseek-chat" })).toBeVisible();
  expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
});

test("ModelMenuConsumesEscapeAndEnterBeforeDialog", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="edit" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "编辑 deepseek-chat" }));
  fireEvent.change(page.getByLabelText("上下文窗口大小"), { target: { value: "256000" } });
  await userEvent.click(page.getByRole("button", { name: "选择上下文窗口大小" }));
  await userEvent.keyboard("{Escape}");
  expect(page.getByRole("dialog", { name: "编辑模型" })).toBeVisible();
  expect(page.queryByRole("button", { name: "192K" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "选择上下文窗口大小" }));
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(page.getByLabelText("上下文窗口大小")).toHaveValue("1000000");
  expect(page.getByRole("dialog", { name: "编辑模型" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(page.getByRole("dialog", { name: "修改模型提供商" })).toBeVisible();
});

test("ModelHeadersValidateAndRoundTrip", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "编辑 demo-text" }));
  const model = within(page.getByRole("dialog", { name: "编辑模型" }));
  await userEvent.click(model.getByRole("button", { name: "+ 添加" }));
  fireEvent.change(model.getByLabelText("Header 1 Value"), { target: { value: "preview" } });
  expect(model.getByRole("button", { name: "保存模型" })).toBeDisabled();
  fireEvent.change(model.getByLabelText("Header 1 Key"), { target: { value: "X-Test" } });
  await userEvent.click(model.getByRole("button", { name: "+ 添加" }));
  fireEvent.change(model.getByLabelText("Header 2 Key"), { target: { value: "x-test" } });
  expect(model.getByRole("button", { name: "保存模型" })).toBeDisabled();
  fireEvent.change(model.getByLabelText("Header 2 Key"), { target: { value: "X-Other" } });
  fireEvent.change(model.getByLabelText("Header 2 Value"), { target: { value: "second" } });
  await userEvent.click(model.getByRole("button", { name: "保存模型" }));

  await userEvent.click(page.getByRole("button", { name: "编辑 demo-text" }));
  const saved = within(page.getByRole("dialog", { name: "编辑模型" }));
  expect(saved.getByLabelText("Header 1 Key")).toHaveValue("X-Test");
  expect(saved.getByLabelText("Header 1 Value")).toHaveValue("preview");
  expect(saved.getByLabelText("Header 2 Value")).toHaveValue("second");

  await userEvent.click(saved.getByRole("button", { name: "删除 Header 1" }));
  expect(saved.getByLabelText("Header 1 Key")).toHaveValue("X-Other");
  await userEvent.click(saved.getByRole("button", { name: "删除 Header 1" }));
  await userEvent.click(saved.getByRole("button", { name: "保存模型" }));

  await userEvent.click(page.getByRole("button", { name: "编辑 demo-text" }));
  const cleared = within(page.getByRole("dialog", { name: "编辑模型" }));
  expect(cleared.queryByLabelText("Header 1 Key")).not.toBeInTheDocument();
});

test("ThinkingPresetRoundTrip", async () => {
  render(<SettingsPreview initialTab="llm" initialModelDialog="editCustom" />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "编辑 demo-text" }));
  expect(page.getByRole("button", { name: "深度思考" })).toHaveTextContent("不支持推理");
  await userEvent.click(page.getByRole("button", { name: "深度思考" }));
  expect(page.queryByRole("button", { name: "自动适配" })).not.toBeInTheDocument();
  expect(page.queryByRole("button", { name: "模型原有映射" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "低 / 中 / 高" }));
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  expect(within(page.getByRole("group", { name: "demo-text" })).getByText("深度思考")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "编辑 demo-text" }));
  expect(page.getByRole("button", { name: "深度思考" })).toHaveTextContent("低 / 中 / 高");
  await userEvent.click(page.getByRole("button", { name: "深度思考" }));
  await userEvent.click(page.getByRole("button", { name: "不支持推理" }));
  await userEvent.click(page.getByRole("button", { name: "保存模型" }));
  expect(within(page.getByRole("group", { name: "demo-text" })).queryByText("深度思考")).not.toBeInTheDocument();
});
