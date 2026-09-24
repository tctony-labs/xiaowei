import { useState } from "react";
import { COMMON_CONTEXT_WINDOWS } from "./context-window-presets";
import Select from "./Select";

const CUSTOM = "custom";

interface ContextWindowFieldProps {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  /** 未设置时下拉框显示的文案，如「未设置」「跟随默认」。 */
  unsetLabel: string;
  presets?: Array<{ tokens: number; label: string }>;
  customLabel?: string;
}

export default function ContextWindowField({
  value,
  onChange,
  unsetLabel,
  presets = COMMON_CONTEXT_WINDOWS,
  customLabel = "自定义 token 数",
}: ContextWindowFieldProps) {
  const isCommon = value != null && presets.some((option) => option.tokens === value);
  // null 表示使用下拉档位；字符串同时承载自定义模式和输入草稿，确保清空输入时不会立刻
  // 退出自定义模式。
  const [customDraft, setCustomDraft] = useState<string | null>(value != null && !isCommon ? String(value) : null);
  const draftMatchesValue =
    customDraft !== null &&
    ((value == null && (!customDraft || !Number.isSafeInteger(Number(customDraft)) || Number(customDraft) < 1)) ||
      Number(customDraft) === value);
  // 弹窗先挂载、再从 provider 同步表单值，因此最新 value 是自定义值时直接回显，不能只
  // 依赖 useState 初始化。匹配当前值的 draft 则表示用户主动进入了自定义模式。
  const customInput = draftMatchesValue ? customDraft : value != null && !isCommon ? String(value) : null;

  const options = [
    { value: "", label: unsetLabel },
    ...presets.map((option) => ({ value: String(option.tokens), label: option.label })),
    { value: CUSTOM, label: "自定义" },
  ];

  const selected = customInput !== null ? CUSTOM : value != null ? String(value) : "";

  const handleSelect = (next: string) => {
    if (next === CUSTOM) {
      setCustomDraft(value == null ? "" : String(value));
      return;
    }
    setCustomDraft(null);
    onChange(next ? Number(next) : undefined);
  };

  return (
    <div className="flex items-center gap-2">
      {/* 自定义值直接输入 token 数，避免 number 的上下步进箭头。 */}
      {customInput !== null && (
        <input
          type="text"
          inputMode="numeric"
          aria-label={customLabel}
          value={customInput}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, "");
            setCustomDraft(digits);
            const tokens = Number(digits);
            onChange(digits && Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined);
          }}
          placeholder="tokens"
          className="w-24 rounded-lg border border-line bg-surface px-2 py-1 text-[13px] text-ink outline-none
              placeholder:text-muted focus:border-primary"
        />
      )}
      <Select options={options} value={selected} onChange={handleSelect} menuPortal />
    </div>
  );
}
