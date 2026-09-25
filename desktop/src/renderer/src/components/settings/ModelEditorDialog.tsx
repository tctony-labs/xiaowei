import { useRef, useState } from "react";
import { defaultContextWindow, defaultMaxTokens, matchThinkingMap } from "../../../../shared/llm-models";
import Modal, { ModalButton } from "../Modal";
import ContextWindowField from "./ContextWindowField";
import { COMMON_MAX_OUTPUT_TOKENS } from "./context-window-presets";
import type { Provider } from "./ModelSettings";
import Select from "./Select";
import { type ThinkingLevelMap, thinkingLevelPresets } from "./thinking-level-presets";

export default function ModelEditorDialog({
  provider,
  originalId,
  onClose,
  onSave,
}: {
  provider: Provider;
  originalId: string | null;
  onClose: () => void;
  onSave: (value: Partial<Provider>) => void;
}) {
  const initialConfig = originalId ? provider.modelConfigs?.[originalId] : undefined;
  const [modelId, setModelId] = useState(originalId ?? "");
  const [name, setName] = useState(initialConfig?.name ?? "");
  const [supportsImage, setSupportsImage] = useState(initialConfig?.supportsImage ?? false);
  const initialThinking = initialConfig?.reasoning ? matchThinkingMap(initialConfig.thinkingLevelMap) : undefined;
  const [reasoning, setReasoning] = useState(Boolean(initialThinking));
  const [thinkingLevelMap, setThinkingLevelMap] = useState<ThinkingLevelMap | undefined>(initialThinking?.map);
  const matchingPreset = matchThinkingMap(thinkingLevelMap);
  const thinkingPreset = matchingPreset?.id ?? "";
  const [headerRows, setHeaderRows] = useState(() =>
    Object.entries(initialConfig?.headers ?? {}).map(([key, value], id) => ({ id, key, value })),
  );
  const nextHeaderId = useRef(headerRows.length);
  const filledHeaders = headerRows.filter((row) => row.key.trim() || row.value);
  const headerNames = filledHeaders.map((row) => row.key.trim().toLowerCase());
  const headersError = filledHeaders.some((row) => !row.key.trim())
    ? "请输入 Header 名称"
    : new Set(headerNames).size !== headerNames.length
      ? "Header 名称不能重复（不区分大小写）"
      : "";
  const headers = filledHeaders.length
    ? Object.fromEntries(filledHeaders.map((row) => [row.key.trim(), row.value]))
    : undefined;

  const [context, setContext] = useState(
    (originalId ? provider.modelContextWindows[originalId] : undefined) ?? defaultContextWindow,
  );
  const [maxOutput, setMaxOutput] = useState(initialConfig?.maxOutput ?? defaultMaxTokens);
  const id = modelId.trim();
  const duplicate = id !== originalId && provider.models.includes(id);
  const thinkingError = reasoning && !thinkingLevelMap ? "请选择明确的思考强度方案" : "";
  const limitsError =
    (maxOutput ?? defaultMaxTokens) > (context ?? defaultContextWindow) ? "最大输出数量不能超过上下文窗口大小" : "";
  const canSave = Boolean(id) && !duplicate && !headersError && !thinkingError && !limitsError;

  function addHeader() {
    const id = nextHeaderId.current++;
    setHeaderRows((rows) => [...rows, { id, key: "", value: "" }]);
  }

  function save() {
    if (!canSave) return;

    const windows = { ...provider.modelContextWindows };
    const limits = { ...provider.modelContextLimits };
    const configs = { ...provider.modelConfigs };
    const sourceContext = originalId ? limits[originalId] : undefined;
    if (originalId !== null) {
      delete windows[originalId];
      delete limits[originalId];
      delete configs[originalId];
    }
    if (context != null) windows[id] = context;
    if (sourceContext != null) limits[id] = sourceContext;
    configs[id] = {
      ...initialConfig,
      name: name.trim() || undefined,
      supportsImage,
      reasoning,
      thinkingLevelMap,
      headers,
      maxOutput,
    };
    onSave({
      models:
        originalId === null
          ? [...provider.models, id]
          : provider.models.map((item) => (item === originalId ? id : item)),
      modelContextWindows: windows,
      modelContextLimits: limits,
      modelConfigs: configs,
    });
    onClose();
  }

  return (
    <Modal
      open
      title={originalId === null ? "添加模型" : "编辑模型"}
      width="w-[440px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-64px)]"
      contentClassName="min-h-0 overflow-y-auto px-5 py-3"
      onClose={onClose}
      onConfirm={canSave ? save : undefined}
      footer={
        <>
          <ModalButton onClick={onClose}>取消</ModalButton>
          <ModalButton variant="primary" disabled={!canSave} onClick={save}>
            {originalId === null ? "添加模型" : "保存模型"}
          </ModalButton>
        </>
      }
    >
      <div className="space-y-4 py-2 text-[13px]">
        <label className="grid grid-cols-[112px_1fr] items-center gap-4">
          <span>模型 ID</span>
          <input
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder="输入模型 ID"
            className="min-w-0 w-full rounded-lg border border-line bg-surface px-3 py-1.5 outline-none"
          />
        </label>
        {duplicate && (
          <p role="alert" className="pl-32 text-[12px] text-danger">
            该模型已添加
          </p>
        )}
        <label className="grid grid-cols-[112px_1fr] items-center gap-4">
          <span>模型名称（可选）</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="未填写时使用 ID"
            className="min-w-0 w-full rounded-lg border border-line bg-surface px-3 py-1.5 outline-none"
          />
        </label>
        <label className="grid grid-cols-[112px_1fr] items-center gap-4">
          <span>支持图片输入</span>
          <input
            type="checkbox"
            className="justify-self-start"
            checked={supportsImage}
            onChange={(event) => setSupportsImage(event.target.checked)}
          />
        </label>
        <div className="grid grid-cols-[112px_1fr] items-center gap-4">
          <span>思考强度</span>
          <Select
            ariaLabel="思考强度"
            className="min-w-0"
            buttonClassName="w-full min-w-0 justify-between [&>span]:truncate [&>svg]:shrink-0"
            value={reasoning ? thinkingPreset : "disabled"}
            placeholder="请选择思考强度方案"
            options={[
              { value: "disabled", label: "不支持推理" },
              ...thinkingLevelPresets.map((preset) => ({ value: preset.id, label: preset.label })),
            ]}
            onChange={(id) => {
              setReasoning(id !== "disabled");
              setThinkingLevelMap(thinkingLevelPresets.find((item) => item.id === id)?.map);
            }}
            menuPortal
          />
        </div>
        {thinkingError && (
          <p role="alert" className="text-[12px] text-danger">
            {thinkingError}
          </p>
        )}
        <div className="grid grid-cols-[112px_1fr] items-center gap-4">
          <span>上下文窗口大小</span>
          <div className="justify-self-start">
            <ContextWindowField
              value={context}
              suggestedValue={originalId ? provider.modelContextLimits[originalId] : undefined}
              unsetLabel="未设置"
              onChange={(value) => setContext(value ?? defaultContextWindow)}
            />
          </div>
        </div>
        <div className="grid grid-cols-[112px_1fr] items-center gap-4">
          <span>最大输出数量</span>
          <div className="justify-self-start">
            <ContextWindowField
              value={maxOutput}
              suggestedValue={initialConfig?.defaultMaxOutput}
              unsetLabel="未设置"
              presets={COMMON_MAX_OUTPUT_TOKENS}
              customLabel="最大输出 token"
              onChange={(value) => setMaxOutput(value ?? defaultMaxTokens)}
            />
          </div>
        </div>
        <div className="grid grid-cols-[112px_1fr] items-center gap-4">
          <span>自定义请求头</span>
          <div className="min-w-0 space-y-2">
            {headerRows.map((row, index) => (
              <div key={row.id} className="flex items-center gap-2">
                <input
                  aria-label={`Header ${index + 1} Key`}
                  value={row.key}
                  placeholder="Key"
                  spellCheck={false}
                  onChange={(event) =>
                    setHeaderRows((rows) =>
                      rows.map((item) => (item.id === row.id ? { ...item, key: event.target.value } : item)),
                    )
                  }
                  className="min-w-0 flex-1 rounded-lg border border-line bg-surface
                    px-2 py-1.5 text-[12px] outline-none"
                />
                <input
                  aria-label={`Header ${index + 1} Value`}
                  value={row.value}
                  placeholder="Value"
                  spellCheck={false}
                  onChange={(event) =>
                    setHeaderRows((rows) =>
                      rows.map((item) => (item.id === row.id ? { ...item, value: event.target.value } : item)),
                    )
                  }
                  className="min-w-0 flex-1 rounded-lg border border-line bg-surface
                    px-2 py-1.5 text-[12px] outline-none"
                />
                <button
                  type="button"
                  aria-label={`删除 Header ${index + 1}`}
                  className="shrink-0 cursor-pointer px-1 text-muted hover:text-danger"
                  onClick={() => setHeaderRows((rows) => rows.filter((item) => item.id !== row.id))}
                >
                  ×
                </button>
                <span className="w-11 shrink-0">
                  {index === headerRows.length - 1 && (
                    <button
                      type="button"
                      aria-label="+ 添加"
                      title="添加"
                      className="cursor-pointer text-primary-text"
                      onClick={addHeader}
                    >
                      + 添加
                    </button>
                  )}
                </span>
              </div>
            ))}
            {!headerRows.length && (
              <button type="button" className="cursor-pointer text-[12px] text-primary-text" onClick={addHeader}>
                + 添加
              </button>
            )}
          </div>
        </div>
        {limitsError && (
          <p role="alert" className="text-[12px] text-danger">
            {limitsError}
          </p>
        )}
        {headersError && (
          <p role="alert" className="text-[12px] text-danger">
            {headersError}
          </p>
        )}
      </div>
    </Modal>
  );
}
