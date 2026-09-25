import { useEffect, useState } from "react";
import Modal, { ModalButton } from "../Modal";
import ModelEditorDialog from "./ModelEditorDialog";
import type { Provider } from "./ModelSettings";
import { modelDisplayName } from "./model-display-name";

export default function ModelCatalog({
  provider,
  onChange,
  onDialogOpenChange,
}: {
  provider: Provider;
  onChange: (value: Partial<Provider>) => void;
  onDialogOpenChange: (open: boolean) => void;
}) {
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    onDialogOpenChange(editing !== null || deleting !== null);
  }, [editing, deleting, onDialogOpenChange]);

  return (
    <div className="space-y-2">
      {provider.models.map((model) => {
        const context = provider.modelContextWindows[model];
        const config = provider.modelConfigs?.[model] ?? { supportsImage: false };
        return (
          <fieldset key={model} aria-label={model} className="min-w-0 px-1 py-1.5">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <span className="min-w-0">
                  <span className="block break-all text-[13px]">{modelDisplayName(config.name, model)}</span>
                  {(config.supportsImage || config.reasoning || context != null || config.maxOutput != null) && (
                    <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                      {config.supportsImage && (
                        <span className="rounded bg-primary-bg px-1.5 py-0.5 text-primary-text">多模态</span>
                      )}
                      {config.reasoning && (
                        <span className="rounded bg-primary-bg px-1.5 py-0.5 text-primary-text">深度思考</span>
                      )}
                      {context != null && <span>上下文 {context.toLocaleString()}</span>}
                      {config.maxOutput != null && <span>输出 {config.maxOutput.toLocaleString()}</span>}
                    </span>
                  )}
                </span>
              </div>
              <button
                type="button"
                aria-label={`编辑 ${model}`}
                title="编辑"
                className="shrink-0 cursor-pointer p-1 text-muted hover:text-primary-text"
                onClick={() => setEditing({ id: model })}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m16 3 5 5L9 20l-6 1 1-6L16 3Z M13 6l5 5" />
                </svg>
              </button>
              <button
                type="button"
                aria-label={`删除 ${model}`}
                className="cursor-pointer p-1 text-muted hover:text-danger"
                onClick={() => setDeleting(model)}
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
          </fieldset>
        );
      })}
      {!provider.models.length && (
        <p className="py-2 text-center text-[12px] text-muted">暂无可用模型，请导入或添加模型</p>
      )}
      <button
        type="button"
        className="w-full cursor-pointer rounded-lg border border-dashed border-line py-2
          text-[12px] text-ink-secondary hover:bg-hover"
        onClick={() => setEditing({ id: null })}
      >
        + 添加模型
      </button>
      {editing && (
        <ModelEditorDialog
          provider={provider}
          originalId={editing.id}
          onClose={() => setEditing(null)}
          onSave={onChange}
        />
      )}
      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="删除模型"
        footer={
          <>
            <ModalButton onClick={() => setDeleting(null)}>取消</ModalButton>
            <ModalButton
              variant="danger"
              onClick={() => {
                if (deleting === null) return;

                const windows = { ...provider.modelContextWindows };
                const limits = { ...provider.modelContextLimits };
                const configs = { ...provider.modelConfigs };
                delete windows[deleting];
                delete limits[deleting];
                delete configs[deleting];
                onChange({
                  models: provider.models.filter((id) => id !== deleting),
                  modelContextWindows: windows,
                  modelContextLimits: limits,
                  modelConfigs: configs,
                });
                setDeleting(null);
              }}
            >
              确认删除
            </ModalButton>
          </>
        }
      >
        <p className="text-[13px] text-ink-secondary">
          确定删除模型“{deleting && modelDisplayName(provider.modelConfigs?.[deleting]?.name, deleting)}”？
        </p>
      </Modal>
    </div>
  );
}
