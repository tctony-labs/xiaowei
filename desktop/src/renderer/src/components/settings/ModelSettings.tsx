import { useState } from "react";
import Modal, { ModalButton } from "../Modal";
import ContextWindowField from "./ContextWindowField";
import Select from "./Select";
import SettingCard from "./SettingCard";
import SettingRow from "./SettingRow";
import SettingsTabLayout from "./SettingsTabLayout";
import Toggle from "./Toggle";

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  protocol: string;
  transport: string;
  hasApiKey: boolean;
  models: string[];
  defaultModel: string;
  contextWindow: number | null;
  modelContextWindows: Record<string, number>;
}
export interface ModelValues {
  defaultModel: string;
  smallModel: string;
  reasoning: string;
  imageModel: string;
  providerId: string;
  localEnabled: boolean;
  localModel: string;
}
export type DownloadState = "missing" | "downloading" | "verifying" | "unzipping" | "ready" | "failed";
export interface LocalModel {
  id: string;
  name: string;
  disk: number;
  memory: number | null;
  recommendation: string;
  state: DownloadState;
  progress: number;
  failure?: string;
}
export interface ModelSettingsProps {
  values: ModelValues;
  providers: Provider[];
  localModels: LocalModel[];
  diskGB: number;
  onChange: (values: ModelValues) => void;
  onSaveProvider: (provider: Provider, key: string) => Promise<Provider>;
  onDeleteProvider: (id: string) => Promise<void>;
  onSelectLocal: (id: string) => void;
  onOpenDirectory: () => void;
  onTestImage: (id: string) => Promise<void>;
  initialDialog?: "add" | "edit" | "local" | "switch";
  highlightLocal?: boolean;
  imageTesting?: boolean;
}
const actionClass = "cursor-pointer rounded-md bg-primary/10 px-3 py-1 text-[12px] font-medium text-primary-text";
const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] outline-none focus:border-primary";
const emptyProvider: Provider = {
  id: "",
  name: "",
  baseUrl: "",
  protocol: "openai",
  transport: "http",
  hasApiKey: false,
  models: [],
  defaultModel: "",
  contextWindow: null,
  modelContextWindows: {},
};
export function ModelSettings(props: ModelSettingsProps) {
  const { values, providers, localModels, onChange } = props;
  const [editor, setEditor] = useState<Provider | null>(() =>
    props.initialDialog === "add"
      ? emptyProvider
      : props.initialDialog === "edit"
        ? (providers[0] ?? emptyProvider)
        : null,
  );
  const [picker, setPicker] = useState(props.initialDialog === "local");
  const [pendingSwitch, setPendingSwitch] = useState<Provider | null>(
    props.initialDialog === "switch" ? (providers[0] ?? null) : null,
  );
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");
  const remoteOptions = providers
    .filter((p) => p.hasApiKey)
    .flatMap((p) =>
      p.models.map((model) => ({
        value: `${p.name}/${model}`,
        label: `${p.name} / ${model}`,
      })),
    );
  const current = localModels.find((model) => model.id === values.localModel);
  const modelOptions = [
    ...remoteOptions,
    ...(values.localEnabled ? [{ value: "local", label: current?.name ?? "local" }] : []),
  ];
  const imageOptions = [{ value: "", label: "未设置" }, ...remoteOptions];
  const update = (key: keyof ModelValues, value: string | boolean) => onChange({ ...values, [key]: value });
  async function testImage(id: string) {
    if (!id) {
      update("imageModel", "");
      return;
    }
    setTesting(true);
    setMessage("");
    try {
      await props.onTestImage(id);
      update("imageModel", id);
      setMessage("图片生成模型验证成功");
    } catch {
      setMessage("该模型不支持图片生成，请选择其他模型");
    } finally {
      setTesting(false);
    }
  }
  return (
    <SettingsTabLayout title="模型">
      <SettingCard>
        <SettingRow title="默认模型" description="新建对话时使用的模型">
          <Select
            value={values.defaultModel}
            options={modelOptions}
            disabled={!modelOptions.length}
            placeholder="未配置"
            onChange={(value) => update("defaultModel", value)}
            menuPortal
          />
        </SettingRow>
        <SettingRow title="小文本任务模型" description="用于自动生成会话标题等轻量文本任务">
          <Select
            value={values.smallModel}
            options={modelOptions}
            disabled={!modelOptions.length}
            placeholder="未配置"
            onChange={(value) => update("smallModel", value)}
            menuPortal
          />
        </SettingRow>
        <SettingRow title="默认思考模式" description="新建对话时使用的思考强度">
          <Select
            value={values.reasoning}
            onChange={(value) => update("reasoning", value)}
            options={[
              { value: "off", label: "关闭" },
              { value: "low", label: "较小" },
              { value: "medium", label: "中等" },
              { value: "high", label: "较大" },
              { value: "max", label: "极大" },
            ]}
          />
        </SettingRow>
        <SettingRow title="图片生成模型" description="选择后会发起一次图片生成测试">
          <div className="flex items-center gap-2">
            {(testing || props.imageTesting) && (
              <span role="status" className="text-[12px] text-muted">
                验证中
              </span>
            )}
            <Select
              value={values.imageModel}
              options={imageOptions}
              disabled={testing || props.imageTesting}
              onChange={(value) => void testImage(value)}
              menuPortal
            />
          </div>
        </SettingRow>
      </SettingCard>
      <SettingCard>
        <SettingRow title="模型提供商">
          <div className="flex items-center gap-2">
            <Select
              value={values.providerId}
              placeholder="未配置"
              options={providers.map((p) => ({ value: p.id, label: p.hasApiKey ? p.name : `${p.name}（未配置 Key）` }))}
              onChange={(id) => {
                const provider = providers.find((p) => p.id === id);
                if (!provider?.hasApiKey) setMessage("请先配置该模型提供商的 API Key");
                else onChange({ ...values, providerId: id, defaultModel: `${provider.name}/${provider.defaultModel}` });
              }}
            />
            <button
              type="button"
              className="cursor-pointer rounded-md bg-primary px-3 py-1 text-[12px] font-medium text-white"
              onClick={() => setEditor(emptyProvider)}
            >
              添加
            </button>
          </div>
        </SettingRow>
        <div className="space-y-2 px-5 py-3">
          {providers.map((provider) => (
            <div
              key={provider.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-subtle px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium leading-[18px]">{provider.name}</div>
                <div className="mt-0.5 truncate text-[11px] leading-[14px] text-muted">
                  {provider.baseUrl} ·{" "}
                  {provider.protocol === "openai"
                    ? "OpenAI Chat"
                    : provider.protocol === "responses"
                      ? "OpenAI Responses"
                      : "Anthropic"}
                </div>
              </div>
              <button
                type="button"
                className="cursor-pointer rounded-md bg-hover px-3 py-1 text-[12px] font-medium"
                onClick={() => setEditor(provider)}
              >
                修改
              </button>
            </div>
          ))}
        </div>
      </SettingCard>
      <div id="settings-local-model" className={`rounded-xl ${props.highlightLocal ? "ring-2 ring-primary/60" : ""}`}>
        <SettingCard>
          <SettingRow title="启用本地模型" description="开启后会下载并运行本地模型，使用时可保护个人隐私">
            <Toggle
              ariaLabel="启用本地模型"
              checked={values.localEnabled}
              onChange={() => update("localEnabled", !values.localEnabled)}
            />
          </SettingRow>
          {values.localEnabled && (
            <div className="px-5 py-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[14px]">{current?.name ?? "未选择"}</span>
                <div className="flex items-center gap-3">
                  <ModelStateBadge model={current} />
                  <button type="button" className={actionClass} onClick={() => setPicker(true)}>
                    切换
                  </button>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
                <span>磁盘占用 {props.diskGB.toFixed(1)} GB</span>
                <button
                  type="button"
                  className="cursor-pointer px-2 py-1 text-[12px] text-muted"
                  onClick={props.onOpenDirectory}
                >
                  打开模型目录
                </button>
              </div>
            </div>
          )}
        </SettingCard>
      </div>
      {message && (
        <p role="status" className="text-[12px] text-ink-secondary">
          {message}
        </p>
      )}
      {editor && (
        <ProviderEditor
          key={editor.id}
          provider={editor}
          onClose={() => setEditor(null)}
          onSave={async (provider, key) => {
            const saved = await props.onSaveProvider(provider, key);
            setEditor(null);
            if (saved.id !== values.providerId) setPendingSwitch(saved);
            else setMessage("已保存");
          }}
          onDelete={async () => {
            await props.onDeleteProvider(editor.id);
            setEditor(null);
            setMessage("已删除");
          }}
        />
      )}
      <Modal
        open={!!pendingSwitch}
        onClose={() => setPendingSwitch(null)}
        title="切换模型提供商"
        footer={
          <>
            <ModalButton onClick={() => setPendingSwitch(null)}>暂不切换</ModalButton>
            <ModalButton
              variant="primary"
              onClick={() => {
                if (pendingSwitch)
                  onChange({
                    ...values,
                    providerId: pendingSwitch.id,
                    defaultModel: `${pendingSwitch.name}/${pendingSwitch.defaultModel}`,
                  });
                setPendingSwitch(null);
              }}
            >
              切换
            </ModalButton>
          </>
        }
      >
        <p className="text-[13px]">是否切换到 {pendingSwitch?.name}？</p>
      </Modal>
      <Modal
        open={values.localEnabled && picker}
        onClose={() => setPicker(false)}
        title="切换本地模型"
        width="w-[480px]"
      >
        <div className="settings-scrollbar max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {localModels.map((model) => (
            <LocalModelRow
              key={model.id}
              model={model}
              active={values.localModel === model.id}
              onSelect={() => {
                setPicker(false);
                props.onSelectLocal(model.id);
              }}
            />
          ))}
        </div>
      </Modal>
    </SettingsTabLayout>
  );
}
export function ModelStateBadge({ model }: { model?: LocalModel }) {
  const state = model?.state ?? "missing";
  const labels = {
    missing: "未下载",
    downloading: `下载中 ${model?.progress ?? 0}%`,
    verifying: "校验中",
    unzipping: "解压中",
    ready: "已就绪",
    failed: "下载失败",
  };
  const color =
    state === "ready"
      ? "bg-primary"
      : state === "failed"
        ? "bg-danger"
        : state === "missing"
          ? "bg-muted"
          : "bg-blue-500";
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      {labels[state]}
    </span>
  );
}
function LocalModelRow({ model, active, onSelect }: { model: LocalModel; active: boolean; onSelect: () => void }) {
  const busy = ["downloading", "verifying", "unzipping"].includes(model.state);
  return (
    <div
      className={`flex min-h-[60px] items-center gap-4 rounded-lg border px-4 py-2
    ${active ? "border-primary bg-primary/5" : "border-line"} ${model.recommendation === "不推荐" ? "opacity-55" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{model.name}</span>
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary-text">
            {model.recommendation}
          </span>
        </div>
        <div className="mt-1 text-xs text-muted">
          磁盘 {model.disk.toFixed(2)} GB · 内存 {model.memory?.toFixed(2) ?? "—"} GB
        </div>
        {model.state === "failed" && <p className="mt-1 text-[10px] text-danger">{model.failure}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {busy ? (
          <>
            <div className="h-1 w-16 overflow-hidden rounded-full bg-subtle">
              <div
                className={`h-full rounded-full ${
                  model.state === "downloading" ? "bg-primary" : "animate-pulse bg-primary/40"
                }`}
                style={{ width: `${model.state === "downloading" ? model.progress : 100}%` }}
              />
            </div>
            <span className="text-[10px] text-muted">
              {model.state === "downloading" ? `${model.progress}%` : model.state === "verifying" ? "校验中" : "解压中"}
            </span>
          </>
        ) : (
          !active && (
            <button type="button" className={actionClass} onClick={onSelect}>
              {model.state === "ready" ? "切换" : model.state === "failed" ? "重试" : "下载并切换"}
            </button>
          )
        )}
        {active && <span className="text-xs font-medium text-primary-text">使用中</span>}
      </div>
    </div>
  );
}
export function ProviderEditor({
  provider,
  onClose,
  onSave,
  onDelete,
}: {
  provider: Provider;
  onClose: () => void;
  onSave: (provider: Provider, key: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [form, setForm] = useState(provider);
  const [apiKey, setApiKey] = useState("");
  const [preset, setPreset] = useState(
    provider.baseUrl === "https://api.deepseek.com/v1" ? "deepseek-openai" : "custom",
  );
  const [overrides, setOverrides] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (next: Partial<Provider>) => setForm({ ...form, ...next });
  async function submit(remove = false) {
    if (busy || (!remove && (!form.name.trim() || !form.baseUrl.trim() || (!provider.hasApiKey && !apiKey.trim()))))
      return;
    setBusy(true);
    setError("");
    try {
      if (remove) await onDelete();
      else await onSave(form, apiKey);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      open
      onClose={close}
      onConfirm={() => void submit()}
      title={provider.id ? "修改模型提供商" : "添加模型提供商"}
      width="max-h-[calc(100vh-32px)] w-[480px]"
      contentClassName="settings-scrollbar min-h-0 overflow-y-auto px-5 py-4"
      footer={
        <>
          {provider.id && (
            <ModalButton
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (confirmDelete) void submit(true);
                else setConfirmDelete(true);
              }}
            >
              {confirmDelete ? "确认删除" : "删除"}
            </ModalButton>
          )}
          <ModalButton onClick={close} disabled={busy}>
            取消
          </ModalButton>
          <ModalButton
            variant="primary"
            disabled={busy || !form.name.trim() || !form.baseUrl.trim() || (!provider.hasApiKey && !apiKey.trim())}
            onClick={() => void submit()}
          >
            {busy ? "校验中..." : "保存"}
          </ModalButton>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between text-[12px] text-ink-secondary">
          预设 Provider
          <Select
            value={preset}
            options={[
              { value: "deepseek-openai", label: "deepseek" },
              { value: "custom", label: "自定义" },
            ]}
            onChange={(value) => {
              setPreset(value);
              if (value !== "custom")
                update({
                  name: "deepseek",
                  baseUrl: "https://api.deepseek.com/v1",
                  protocol: "openai",
                  contextWindow: 1_000_000,
                  models: [],
                  defaultModel: "",
                  modelContextWindows: {},
                });
            }}
            menuPortal
          />
        </div>
        <label className="block space-y-1.5 text-[12px] text-ink-secondary">
          名称
          <input
            className={inputClass}
            value={form.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="Provider 名称"
          />
        </label>
        <label className="block space-y-1.5 text-[12px] text-ink-secondary">
          Base URL
          <input
            className={inputClass}
            type="url"
            value={form.baseUrl}
            placeholder="https://api.example.com"
            onChange={(e) => {
              setPreset("custom");
              update({ baseUrl: e.target.value, models: [], defaultModel: "", modelContextWindows: {} });
            }}
          />
        </label>
        <div className="flex items-center justify-between text-[12px] text-ink-secondary">
          Protocol
          <Select
            value={form.protocol}
            options={[
              { value: "openai", label: "OpenAI Chat" },
              { value: "responses", label: "OpenAI Responses" },
              { value: "anthropic", label: "Anthropic" },
            ]}
            onChange={(protocol) => {
              setPreset("custom");
              update({ protocol });
            }}
            menuPortal
          />
        </div>
        {form.protocol === "responses" && (
          <div className="flex items-center justify-between text-[12px]">
            Transport
            <Select
              value={form.transport}
              options={[
                { value: "auto", label: "自动（优先 WebSocket）" },
                { value: "http", label: "仅 HTTP" },
              ]}
              onChange={(transport) => update({ transport })}
              menuPortal
            />
          </div>
        )}
        {form.models.length > 0 && (
          <div className="flex items-center justify-between text-[12px]">
            默认模型
            <Select
              value={form.defaultModel}
              options={form.models.map((value) => ({ value, label: value }))}
              onChange={(defaultModel) => update({ defaultModel })}
              menuPortal
            />
          </div>
        )}
        <div className="flex items-center justify-between text-[12px] text-ink-secondary">
          <button
            type="button"
            disabled={!form.models.length}
            className="cursor-pointer"
            onClick={() => setOverrides(!overrides)}
            aria-expanded={overrides}
            aria-label="上下文窗口"
          >
            上下文窗口 {form.models.length > 0 ? (overrides ? "▾" : "▸") : ""}
          </button>
          <ContextWindowField
            value={form.contextWindow ?? undefined}
            onChange={(contextWindow) => update({ contextWindow: contextWindow ?? null })}
            unsetLabel="未设置"
          />
        </div>
        {overrides && form.models.length > 0 && (
          <div className="space-y-2 rounded-lg border border-subtle px-3 py-2">
            {form.models.map((model) => (
              <div key={model} className="flex items-center justify-between gap-3 text-[13px]">
                <span className="min-w-0 flex-1 truncate">{model}</span>
                <ContextWindowField
                  value={form.modelContextWindows[model]}
                  unsetLabel="默认"
                  onChange={(value) => {
                    const next = { ...form.modelContextWindows };
                    if (value == null) delete next[model];
                    else next[model] = value;
                    update({ modelContextWindows: next });
                  }}
                />
              </div>
            ))}
          </div>
        )}
        <label className="block space-y-1.5 text-[12px] text-ink-secondary">
          API Key
          <input
            className={inputClass}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider.hasApiKey ? "留空则保留当前 API Key" : "请输入 API Key"}
          />
        </label>
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
