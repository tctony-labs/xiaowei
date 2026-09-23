import { useState } from "react";
import ContextWindowField, { COMMON_MAX_OUTPUT_TOKENS } from "./ContextWindowField";
import type { Provider } from "./ModelSettings";

export default function ModelCatalog({
  provider,
  onChange,
}: {
  provider: Provider;
  onChange: (value: Partial<Provider>) => void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [manual, setManual] = useState(false);
  const [modelId, setModelId] = useState("");
  const id = modelId.trim();
  const duplicate = provider.models.includes(id);
  return (
    <div className="space-y-2">
      {provider.models.map((model) => {
        const context = provider.modelContextWindows[model] ?? provider.modelContextLimits[model];
        const config = provider.modelConfigs?.[model] ?? { supportsImage: false };
        const changeConfig = (next: Partial<typeof config>) =>
          onChange({
            modelConfigs: { ...provider.modelConfigs, [model]: { ...config, ...next } },
          });
        const open = expanded.includes(model);
        return (
          <fieldset key={model} aria-label={model} className="min-w-0 rounded-lg border border-line p-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label={`配置 ${model}`}
                aria-expanded={open}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                onClick={() => setExpanded(open ? expanded.filter((id) => id !== model) : [...expanded, model])}
              >
                <span className="text-muted">{open ? "⌄" : "›"}</span>
                <span className="min-w-0">
                  <span className="block break-all text-[13px]">{model}</span>
                  <span className="mt-1 block text-[11px] text-muted">
                    {context != null ? `上下文 ${context.toLocaleString()} tokens` : "上下文窗口：未设置"}
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-label={`删除 ${model}`}
                className="cursor-pointer p-1 text-muted hover:text-danger"
                onClick={() => {
                  const windows = { ...provider.modelContextWindows };
                  const limits = { ...provider.modelContextLimits };
                  const configs = { ...provider.modelConfigs };
                  delete windows[model];
                  delete limits[model];
                  delete configs[model];
                  onChange({
                    models: provider.models.filter((id) => id !== model),
                    modelContextWindows: windows,
                    modelContextLimits: limits,
                    modelConfigs: configs,
                  });
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
                </svg>
              </button>
            </div>
            {open && (
              <div className="mt-3 space-y-3 border-t border-subtle pt-3 text-[12px]">
                <div className="flex items-center justify-between">
                  <span>上下文窗口</span>
                  <ContextWindowField
                    value={provider.modelContextWindows[model]}
                    unsetLabel={
                      provider.modelContextLimits[model]
                        ? `接口 ${provider.modelContextLimits[model].toLocaleString()} tokens`
                        : "未设置"
                    }
                    onChange={(value) => {
                      const next = { ...provider.modelContextWindows };
                      if (value == null) delete next[model];
                      else next[model] = value;
                      onChange({ modelContextWindows: next });
                    }}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>最大输出 token</span>
                  <ContextWindowField
                    value={config.maxOutput}
                    unsetLabel="未设置"
                    presets={COMMON_MAX_OUTPUT_TOKENS}
                    customLabel="自定义最大输出 token"
                    onChange={(maxOutput) => changeConfig({ maxOutput })}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span>输入类型</span>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={config.supportsImage}
                      onChange={(event) => changeConfig({ supportsImage: event.target.checked })}
                    />
                    支持图片
                  </label>
                </div>
              </div>
            )}
          </fieldset>
        );
      })}
      {!provider.models.length && <p className="py-2 text-[12px] text-muted">获取可用模型，或手动添加模型 ID。</p>}
      {manual ? (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <label className="block text-[12px]">
            模型 ID
            <input
              value={modelId}
              placeholder="输入模型 ID"
              className="mt-2 w-full rounded-md border border-line bg-surface px-3 py-1.5 outline-none"
              onChange={(event) => setModelId(event.target.value)}
            />
          </label>
          {duplicate && (
            <p role="alert" className="text-[12px] text-danger">
              该模型已添加
            </p>
          )}
          <div className="flex justify-end gap-3 text-[12px]">
            <button type="button" onClick={() => setManual(false)}>
              取消添加
            </button>
            <button
              type="button"
              disabled={!id || duplicate}
              className="text-primary-text disabled:opacity-40"
              onClick={() => {
                onChange({ models: [...provider.models, id] });
                setExpanded([...expanded, id]);
                setModelId("");
                setManual(false);
              }}
            >
              添加模型
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="w-full cursor-pointer rounded-lg border border-dashed border-line py-2
        text-[12px] text-ink-secondary hover:bg-hover"
          onClick={() => setManual(true)}
        >
          ＋ 手动添加模型
        </button>
      )}
    </div>
  );
}
