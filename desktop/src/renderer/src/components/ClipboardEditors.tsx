import { useEffect, useRef, useState } from "react";
import type { ClipboardCategory, ClipboardItem } from "../../../shared/clipboard-api";
import Modal, { ModalButton } from "./Modal";

export type ClipboardDialog =
  | { type: "text" | "remark" | "assign"; item: ClipboardItem }
  | { type: "category"; category?: ClipboardCategory }
  | { type: "deleteCategory"; category: ClipboardCategory };
export interface ClipboardEditing {
  categories: ClipboardCategory[];
  onReadText(id: string): Promise<string>;
  onEditText(id: string, text: string): Promise<void>;
  onSetRemark(id: string, remark: string): Promise<void>;
  onSetCategory(id: string, category?: string): Promise<void>;
  onSaveCategory(name: string, color: string, id?: string): Promise<void>;
  onDeleteCategory(id: string): Promise<void>;
}
const colors = [
  "#F5222D",
  "#FA541C",
  "#FA8C16",
  "#FADB14",
  "#52C41A",
  "#13C2C2",
  "#1677FF",
  "#722ED1",
  "#EB2F96",
  "#8C8C8C",
];

export function ClipboardEditors({
  dialog,
  onClose,
  ...api
}: ClipboardEditing & {
  dialog: ClipboardDialog;
  onClose(): void;
}) {
  const [value, setValue] = useState(
    dialog.type === "remark"
      ? (dialog.item.remark ?? "")
      : dialog.type === "category"
        ? (dialog.category?.name ?? "")
        : "",
  );
  const [color, setColor] = useState(dialog.type === "category" ? (dialog.category?.color ?? colors[0]) : colors[0]);
  const [loading, setLoading] = useState(dialog.type === "text");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const textId = dialog.type === "text" ? dialog.item.id : undefined;
  useEffect(() => {
    let active = true;
    if (textId)
      void api
        .onReadText(textId)
        .then((text) => {
          if (active) {
            setValue(text);
            setLoading(false);
          }
        })
        .catch(() => {
          if (active) setError("读取文本失败，请关闭后重试");
        });
    return () => {
      active = false;
    };
  }, [textId, api.onReadText]);
  useEffect(() => {
    if (!loading) field.current?.focus();
  }, [loading]);
  async function perform(work: () => Promise<void>) {
    if (inFlight.current || loading) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      onClose();
    } catch {
      setError("保存失败，请检查输入后重试");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function save() {
    if (dialog.type === "text") return perform(() => api.onEditText(dialog.item.id, value));
    if (dialog.type === "remark") return perform(() => api.onSetRemark(dialog.item.id, value.trim()));
    if (dialog.type === "category") return perform(() => api.onSaveCategory(value.trim(), color, dialog.category?.id));
    if (dialog.type === "deleteCategory") return perform(() => api.onDeleteCategory(dialog.category.id));
  }
  const title =
    dialog.type === "text"
      ? "编辑文本"
      : dialog.type === "remark"
        ? "编辑备注"
        : dialog.type === "assign"
          ? "设置分类"
          : dialog.type === "deleteCategory"
            ? "确认删除"
            : dialog.type === "category" && dialog.category
              ? "编辑分类"
              : "新建分类";
  const disabled = busy || loading || ((dialog.type === "text" || dialog.type === "category") && !value.trim());
  const fieldClass =
    "w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] leading-5 " +
    "text-ink placeholder:text-faint outline-none focus:border-primary";
  return (
    <Modal
      open
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
      onConfirm={
        dialog.type === "assign"
          ? undefined
          : () => {
              if (!disabled) void save();
            }
      }
      width={dialog.type === "text" ? "w-[600px]" : undefined}
      footer={
        dialog.type === "assign" ? undefined : (
          <>
            <ModalButton onClick={onClose} disabled={busy}>
              取消
            </ModalButton>
            <ModalButton
              disabled={disabled}
              variant={dialog.type === "deleteCategory" ? "danger" : "primary"}
              onClick={() => void save()}
            >
              {dialog.type === "deleteCategory"
                ? "删除"
                : dialog.type === "category" && !dialog.category
                  ? "确定"
                  : "保存"}
            </ModalButton>
          </>
        )
      }
    >
      {dialog.type === "remark" || dialog.type === "text" ? (
        <textarea
          ref={(el) => {
            field.current = el;
          }}
          aria-label={title}
          value={value}
          disabled={loading || busy}
          onChange={(event) => setValue(event.target.value)}
          rows={dialog.type === "remark" ? 2 : 12}
          placeholder={dialog.type === "remark" ? "输入备注内容…" : "输入文本内容…"}
          className={`${fieldClass} ${dialog.type === "text" ? "min-h-[300px] resize-y text-sm" : "resize-none"}`}
        />
      ) : dialog.type === "category" ? (
        <div className="flex flex-col gap-3">
          <input
            ref={(el) => {
              field.current = el;
            }}
            aria-label="分类名称"
            value={value}
            disabled={busy}
            placeholder="输入分类名称"
            onChange={(event) => setValue(event.target.value)}
            className={fieldClass}
          />
          <div className="flex flex-wrap items-center gap-2">
            {colors.map((item) => (
              <button
                key={item}
                type="button"
                aria-label={`颜色 ${item}`}
                aria-pressed={color === item}
                onClick={() => setColor(item)}
                className="flex size-6 cursor-pointer items-center justify-center rounded-full"
                style={{ backgroundColor: item }}
              >
                {color === item && (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path
                      d="M2.5 6l2.5 2.5 4.5-5"
                      stroke="white"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      ) : dialog.type === "deleteCategory" ? (
        <p className="text-[13px] leading-5 text-ink-secondary">
          确定要删除分类「{dialog.category.name}」吗？该分类下所有数据将变为无分类。
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {[{ id: "", name: "无分类", color: "#8C8C8C" }, ...api.categories].map((category) => (
            <button
              key={category.id}
              type="button"
              disabled={busy}
              onClick={() => void perform(() => api.onSetCategory(dialog.item.id, category.id || undefined))}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] leading-5 ${
                (dialog.item.categoryId ?? "") === category.id ? "bg-primary/10 text-primary-text" : "hover:bg-hover"
              }`}
            >
              {category.id && (
                <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: category.color }} />
              )}
              {category.name}
            </button>
          ))}
          {!api.categories.length && <p className="py-2 text-center text-[13px] text-muted">暂无自定义分类</p>}
        </div>
      )}
      {loading && !error && (
        <p role="status" className="text-sm text-muted">
          加载中…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}
