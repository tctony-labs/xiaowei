import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConfiguredModel } from "xiaowei-contracts";
import Modal, { ModalButton } from "../Modal";
import ModelCatalog from "./ModelCatalog";
import { modelDisplayName } from "./model-display-name";
import { modelProtocols, providerPresets as presets } from "./model-provider-presets";
import Select from "./Select";
import SettingCard from "./SettingCard";
import SettingRow from "./SettingRow";
import SettingsTabLayout from "./SettingsTabLayout";
import Toggle from "./Toggle";
import type { ThinkingLevelMap } from "./thinking-level-presets";
import { matchThinkingMap } from "./thinking-level-presets";

export interface Provider {
  id: string;
  preset: string | null;
  provider?: string;
  revision?: bigint;
  unavailableReason?: string;
  name: string;
  baseUrl: string;
  protocol: string;
  transport: string;
  supportsWebSocket?: boolean;
  hasApiKey: boolean;
  apiKeyEnv?: string;
  models: string[];
  modelContextWindows: Record<string, number>;
  modelContextLimits: Record<string, number>;
  modelConfigs?: Record<
    string,
    {
      localRef?: string;
      original?: ConfiguredModel;
      name?: string;
      supportsImage: boolean;
      reasoning?: boolean;
      thinkingLevelMap?: ThinkingLevelMap;
      headers?: Record<string, string>;
      maxOutput?: number;
      defaultMaxOutput?: number;
    }
  >;
}
export interface ProviderModel {
  id: string;
  contextWindow?: number;
  name?: string;
  supportsImage?: boolean;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  maxOutput?: number;
}

export interface ModelValues {
  defaultModel: string;
  smallModel: string;
  reasoning: string;
  imageModel: string;
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
  onFetchModels: (provider: Provider, key: string, signal?: AbortSignal) => Promise<ProviderModel[]>;
  onDeleteProvider: (id: string, revision?: bigint) => Promise<void>;
  onSelectLocal: (id: string) => void;
  onOpenDirectory: () => void;
  onTestImage: (id: string) => Promise<void>;
  initialDialog?: "add" | "edit" | "editCustom" | "local";
  highlightLocal?: boolean;
  imageTesting?: boolean;
  remoteOnly?: boolean;
}
const actionClass = "cursor-pointer rounded-md bg-primary/10 px-3 py-1 text-[12px] font-medium text-primary-text";
const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] outline-none focus:border-primary";
const emptyProvider: Provider = {
  id: "",
  preset: null,
  name: "",
  baseUrl: "",
  protocol: "openai-completions",
  transport: "http",
  supportsWebSocket: false,
  hasApiKey: false,
  models: [],
  modelContextWindows: {},
  modelContextLimits: {},
};

export function ModelSettings(props: ModelSettingsProps) {
  const { values, providers, localModels, onChange } = props;
  const [editor, setEditor] = useState<Provider | null>(() =>
    props.initialDialog === "add"
      ? emptyProvider
      : props.initialDialog === "editCustom"
        ? (providers.find((provider) => !provider.preset) ?? emptyProvider)
        : props.initialDialog === "edit"
          ? (providers[0] ?? emptyProvider)
          : null,
  );
  const [picker, setPicker] = useState(props.initialDialog === "local");
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState<{ text: string } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  const remoteOptions = providers
    .filter((p) => p.hasApiKey || p.apiKeyEnv?.trim())
    .flatMap((p) =>
      p.models.map((model) => ({
        value: p.modelConfigs?.[model]?.localRef ?? `${p.name}/${model}`,
        label: `${p.name} / ${modelDisplayName(p.modelConfigs?.[model]?.name, model)}`,
      })),
    );
  const selectedModel = providers
    .flatMap((provider) =>
      provider.models.map((id) => ({
        ...provider.modelConfigs?.[id],
        ref: provider.modelConfigs?.[id]?.localRef ?? `${provider.name}/${id}`,
      })),
    )
    .find((model) => model.ref === values.defaultModel);
  const thinkingOptions = [
    { value: "off", label: "关闭" },
    { value: "minimal", label: "最低" },
    { value: "low", label: "较小" },
    { value: "medium", label: "中等" },
    { value: "high", label: "较大" },
    { value: "xhigh", label: "更高" },
    { value: "max", label: "极大" },
  ].filter(
    (option) =>
      selectedModel?.reasoning &&
      typeof selectedModel.thinkingLevelMap?.[option.value as keyof ThinkingLevelMap] === "string",
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
            ariaLabel="默认模型"
            value={values.defaultModel}
            options={modelOptions}
            disabled={!modelOptions.length}
            placeholder="未配置"
            onChange={(value) => update("defaultModel", value)}
            menuPortal
          />
        </SettingRow>
        <SettingRow title="默认思考强度" description="新建对话时使用的思考强度">
          <Select
            ariaLabel="默认思考强度"
            placeholder={!selectedModel ? "请先选择默认模型" : !thinkingOptions.length ? "不支持推理" : "未设置"}
            disabled={!thinkingOptions.length}
            value={values.reasoning}
            onChange={(value) => update("reasoning", value)}
            options={thinkingOptions}
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
        {!props.remoteOnly && (
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
        )}
      </SettingCard>
      <SettingCard>
        <SettingRow title="模型提供商">
          <div className="flex items-center gap-2">
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
          {!providers.length && <p className="py-2 text-center text-[12px] text-muted">暂无模型提供商，请添加</p>}
          {providers.map((provider) => (
            <div
              key={provider.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-subtle px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium leading-[18px]">
                  {provider.name}
                  <span className="ml-2 rounded bg-hover px-1.5 py-0.5 text-[10px] font-normal text-muted">
                    {provider.preset ? "预设" : "自定义"}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[11px] leading-[14px] text-muted">
                  {provider.baseUrl} · {provider.protocol}
                  {provider.unavailableReason && (
                    <span className="block text-danger">{provider.unavailableReason}</span>
                  )}
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
      {!props.remoteOnly && (
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
      )}
      {message && (
        <p role="status" className="text-[12px] text-ink-secondary">
          {message}
        </p>
      )}
      {toast &&
        createPortal(
          <div
            role="status"
            className="pointer-events-none fixed bottom-5 left-1/2 z-[250] max-w-[80%] -translate-x-1/2
              rounded-lg bg-elevated px-4 py-2 text-[13px] text-ink shadow-lg"
          >
            {toast.text}
          </div>,
          document.body,
        )}
      {editor && (
        <ProviderEditor
          key={editor.id}
          provider={editor}
          providers={providers}
          onFetchModels={props.onFetchModels}
          onClose={() => setEditor(null)}
          onSave={async (provider, key) => {
            await props.onSaveProvider(provider, key);
            setEditor(null);
            setToast({ text: "已保存" });
          }}
          onDelete={async () => {
            await props.onDeleteProvider(editor.id, editor.revision);
            setEditor(null);
            setToast({ text: "已删除" });
          }}
        />
      )}
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
  providers,
  onClose,
  onSave,
  onDelete,
  onFetchModels,
}: {
  provider: Provider;
  providers: Provider[];
  onClose: () => void;
  onSave: (provider: Provider, key: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onFetchModels: (provider: Provider, key: string, signal?: AbortSignal) => Promise<ProviderModel[]>;
}) {
  const [form, setForm] = useState(provider);
  const [nameTouched, setNameTouched] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [candidates, setCandidates] = useState<ProviderModel[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const fetchRequest = useRef(0);
  const fetchController = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      fetchController.current?.abort();
    },
    [],
  );
  const [error, setError] = useState("");
  const locked = busy || fetching;
  const selectedPreset = presets.find((preset) => preset.id === form.preset);
  const protocols = selectedPreset?.connections.map((connection) => connection.protocol) ?? modelProtocols;
  const connectionReady =
    !!form.name.trim() &&
    /^https?:\/\//.test(form.baseUrl.trim()) &&
    !form.baseUrl.includes("{") &&
    (form.hasApiKey || !!apiKey.trim() || !!form.apiKeyEnv?.trim());
  const trimmedName = form.name.trim();
  const duplicateName = providers.some((entry) => entry.id !== provider.id && entry.name.trim() === trimmedName);
  const nameError = !trimmedName ? "请输入提供方名称" : duplicateName ? "提供方名称已存在" : "";
  const canSave = connectionReady && !nameError;
  const update = (next: Partial<Provider>) => setForm((current) => ({ ...current, ...next }));

  function selectProvider(next: Partial<Provider>) {
    const preset = presets.find((entry) => entry.id === (next.preset === undefined ? form.preset : next.preset));
    const models = preset?.models ?? [];
    update({
      ...next,
      models: models.map((model) => model.id),
      modelContextWindows: Object.fromEntries(models.map((model) => [model.id, model.contextWindow])),
      modelContextLimits: Object.fromEntries(models.map((model) => [model.id, model.contextWindow])),
      modelConfigs: Object.fromEntries(
        models.map(({ id, name, supportsImage, reasoning, thinkingLevelMap, maxOutput }) => [
          id,
          { name, supportsImage, reasoning, thinkingLevelMap, maxOutput, defaultMaxOutput: maxOutput },
        ]),
      ),
    });
    setError("");
  }

  async function fetchModels() {
    if (locked || !connectionReady) return;
    fetchController.current?.abort();
    const controller = new AbortController();
    fetchController.current = controller;
    const request = ++fetchRequest.current;
    setCandidates([]);
    setSelected([]);
    setSearch("");
    setFetching(true);
    setFetchError("");
    try {
      const fetchedModels = await onFetchModels(form, apiKey, controller.signal);
      if (request !== fetchRequest.current) return;
      setCandidates([...new Map(fetchedModels.map((model) => [model.id, model])).values()]);
    } catch (e) {
      if (request === fetchRequest.current) setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request === fetchRequest.current) setFetching(false);
    }
  }

  function closePicker() {
    fetchController.current?.abort();
    ++fetchRequest.current;
    setFetching(false);
    setCandidates(null);
  }

  async function submit(remove = false) {
    if (locked || (!remove && !canSave)) return;
    setBusy(true);
    setError("");
    try {
      if (remove) await onDelete();
      else await onSave({ ...form, name: trimmedName }, apiKey);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function addSelected() {
    const added = candidates?.filter((model) => selected.includes(model.id) && !form.models.includes(model.id)) ?? [];
    update({
      models: [...form.models, ...added.map((model) => model.id)],
      modelConfigs: {
        ...form.modelConfigs,
        ...Object.fromEntries(
          added.map((model) => [
            model.id,
            {
              name: model.name,
              supportsImage: model.supportsImage ?? false,
              reasoning: Boolean(model.reasoning && matchThinkingMap(model.thinkingLevelMap)),
              thinkingLevelMap: model.reasoning ? matchThinkingMap(model.thinkingLevelMap)?.map : undefined,
              maxOutput: model.maxOutput,
              defaultMaxOutput: model.maxOutput,
            },
          ]),
        ),
      },
      modelContextWindows: {
        ...form.modelContextWindows,
        ...Object.fromEntries(
          added.flatMap((model) => (model.contextWindow == null ? [] : [[model.id, model.contextWindow]])),
        ),
      },
      modelContextLimits: {
        ...form.modelContextLimits,
        ...Object.fromEntries(
          added.flatMap((model) => (model.contextWindow == null ? [] : [[model.id, model.contextWindow]])),
        ),
      },
    });
    setCandidates(null);
  }

  const visible = (candidates ?? []).filter((model) => model.id.toLowerCase().includes(search.toLowerCase()));
  const available = visible.filter((model) => !form.models.includes(model.id));
  const allSelected = available.length > 0 && available.every((model) => selected.includes(model.id));
  const modelPicker =
    candidates !== null ? (
      <Modal
        open
        title="选择要添加的模型"
        width="w-[420px] min-h-[min(320px,calc(100vh-96px))] max-h-[min(480px,calc(100vh-96px))]"
        onClose={closePicker}
        onConfirm={selected.length ? addSelected : undefined}
        contentClassName="flex min-h-0 flex-auto flex-col px-5 py-3"
        footer={
          <>
            <ModalButton onClick={closePicker}>取消</ModalButton>
            <ModalButton variant="primary" disabled={!selected.length} onClick={addSelected}>
              添加{selected.length ? `（${selected.length}）` : ""}
            </ModalButton>
          </>
        }
      >
        {fetching ? (
          <div role="status" aria-label="加载模型" className="flex min-h-0 flex-1 items-center justify-center">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-primary" />
          </div>
        ) : fetchError ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
            <p role="alert" className="text-[12px] text-danger">
              {fetchError}
            </p>
            <button type="button" className={actionClass} onClick={() => void fetchModels()}>
              重试
            </button>
          </div>
        ) : (
          <>
            <div className="mb-3 flex shrink-0 items-center gap-3">
              <input
                className={inputClass}
                aria-label="搜索模型"
                placeholder="搜索模型"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button
                type="button"
                className="shrink-0 cursor-pointer text-[12px] text-primary-text disabled:opacity-40"
                disabled={!available.length}
                onClick={() => {
                  const ids = available.map((model) => model.id);
                  setSelected(
                    allSelected ? selected.filter((id) => !ids.includes(id)) : [...new Set([...selected, ...ids])],
                  );
                }}
              >
                {allSelected ? "取消全选" : "全选"}
              </button>
            </div>
            <div className="settings-scrollbar min-h-0 space-y-1 overflow-y-auto">
              {visible.map((model) => {
                const exists = form.models.includes(model.id);
                return (
                  <label
                    key={model.id}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] hover:bg-hover"
                  >
                    <input
                      type="checkbox"
                      disabled={exists}
                      checked={exists || selected.includes(model.id)}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked ? [...selected, model.id] : selected.filter((id) => id !== model.id),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 break-all">{modelDisplayName(model.name, model.id)}</span>
                    {exists && <span className="shrink-0 text-[11px] text-muted">已添加</span>}
                  </label>
                );
              })}
              {!visible.length && (
                <p role="status" className="py-6 text-center text-[12px] text-muted">
                  {candidates.length ? "没有匹配的模型" : "未获取到可用模型"}
                </p>
              )}
            </div>
          </>
        )}
      </Modal>
    ) : null;

  const close = () => {
    if (!locked) onClose();
  };
  return (
    <>
      <Modal
        open
        inactive={candidates !== null || modelDialogOpen}
        onClose={close}
        onConfirm={() => void submit()}
        title={provider.id ? "修改模型提供商" : "添加模型提供商"}
        width="max-h-[calc(100vh-32px)] w-[480px]"
        contentClassName="settings-scrollbar min-h-0 overflow-y-auto px-5 pt-1 pb-4"
        footer={
          <>
            {provider.id && (
              <ModalButton
                variant="danger"
                disabled={locked}
                onClick={() => {
                  if (confirmDelete) void submit(true);
                  else setConfirmDelete(true);
                }}
              >
                {confirmDelete ? "确认删除" : "删除"}
              </ModalButton>
            )}
            <ModalButton onClick={close} disabled={locked}>
              取消
            </ModalButton>
            <ModalButton variant="primary" disabled={locked || !canSave} onClick={() => void submit()}>
              {busy ? "保存中..." : "保存"}
            </ModalButton>
          </>
        }
      >
        <fieldset disabled={locked} className="min-w-0 space-y-4">
          <div className="flex items-center justify-between text-[12px] text-ink-secondary">
            提供方
            <Select
              className="min-w-[150px]"
              buttonClassName="w-full justify-between"
              value={form.preset ?? "custom"}
              disabled={locked || !!provider.id}
              options={[
                { value: "custom", label: "自定义" },
                ...presets.map((preset) => ({ value: preset.id, label: preset.name })),
              ]}
              onChange={(id) => {
                const preset = presets.find((item) => item.id === id);
                if (preset) {
                  selectProvider({
                    ...emptyProvider,
                    id: form.id,
                    revision: form.revision,
                    preset: id,
                    name: preset.name,
                    apiKeyEnv: preset.apiKeyEnv,
                    supportsWebSocket: preset.supportsWebSocket ?? false,
                    transport: preset.supportsWebSocket === false ? "http" : emptyProvider.transport,
                    ...preset.connections[0],
                  });
                } else selectProvider({ ...emptyProvider, id: form.id, revision: form.revision, apiKeyEnv: "" });
              }}
              menuPortal
            />
          </div>
          <div className="space-y-1.5 text-[12px] text-ink-secondary">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="provider-name">名称</label>
              {nameTouched && nameError && (
                <span id="provider-name-error" role="alert" className="text-danger">
                  {nameError}
                </span>
              )}
            </div>
            <input
              id="provider-name"
              className={inputClass}
              value={form.name}
              aria-invalid={nameTouched && Boolean(nameError)}
              aria-describedby={nameTouched && nameError ? "provider-name-error" : undefined}
              onBlur={() => setNameTouched(true)}
              onChange={(e) => {
                setNameTouched(true);
                update({ name: e.target.value });
              }}
              placeholder="提供方名称"
            />
          </div>
          <label className="block space-y-1.5 text-[12px] text-ink-secondary">
            Base URL
            <input
              className={inputClass}
              type="url"
              value={form.baseUrl}
              readOnly={!!form.preset}
              placeholder="https://api.example.com/v1"
              onChange={(e) => update({ baseUrl: e.target.value })}
            />
          </label>
          <div className="flex items-center justify-between text-[12px] text-ink-secondary">
            Protocol
            <Select
              value={form.protocol}
              disabled={locked || protocols.length === 1}
              options={protocols.map((protocol) => ({ value: protocol, label: protocol }))}
              onChange={(protocol) => {
                const connection = selectedPreset?.connections.find((entry) => entry.protocol === protocol);
                update({
                  ...(connection ?? { protocol }),
                  ...(selectedPreset?.supportsWebSocket === false ? { transport: "http" } : {}),
                });
              }}
              menuPortal
            />
          </div>
          {form.protocol === "openai-responses" && (
            <div className="flex items-center justify-between text-[12px]">
              支持 WebSocket
              <Toggle
                ariaLabel="支持 WebSocket"
                checked={form.supportsWebSocket === true}
                onChange={() =>
                  update({
                    supportsWebSocket: !form.supportsWebSocket,
                    transport: form.supportsWebSocket ? "http" : "auto",
                  })
                }
              />
            </div>
          )}
          <label className="block space-y-1.5 text-[12px] text-ink-secondary">
            API Key 环境变量名（优先使用）
            <input
              className={inputClass}
              value={form.apiKeyEnv ?? ""}
              onChange={(event) => update({ apiKeyEnv: event.target.value })}
              placeholder="例如 DEEPSEEK_API_KEY"
              spellCheck={false}
            />
          </label>
          <div className="space-y-1.5 text-[12px] text-ink-secondary">
            <label htmlFor="provider-api-key">API Key</label>
            <div className="relative">
              <input
                id="provider-api-key"
                className={`${inputClass} pr-14`}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={form.hasApiKey ? "已配置 API Key，留空保留当前值" : "请输入 API Key"}
              />
              {form.hasApiKey && (
                <button
                  type="button"
                  aria-label="清除已保存的 API Key"
                  className="absolute inset-y-0 right-3 cursor-pointer text-[12px] text-danger"
                  onClick={() => {
                    update({ hasApiKey: false });
                    setApiKey("");
                  }}
                >
                  清除
                </button>
              )}
            </div>
          </div>
          <section className="space-y-3 border-t border-subtle pt-3" aria-label="模型列表">
            <div className="flex items-center justify-between text-[12px]">
              <span>模型列表 · {form.models.length} 个</span>
              <button
                type="button"
                className={`${actionClass} disabled:opacity-50`}
                disabled={locked || !connectionReady}
                onClick={() => void fetchModels()}
              >
                导入模型
              </button>
            </div>
            <ModelCatalog provider={form} onChange={update} onDialogOpenChange={setModelDialogOpen} />
          </section>
          {error && (
            <p role="alert" className="text-[12px] text-danger">
              {error}
            </p>
          )}
        </fieldset>
      </Modal>
      {modelPicker}
    </>
  );
}
