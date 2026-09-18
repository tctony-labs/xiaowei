import { useState } from "react";
import Select from "./Select";

/**
 * 常用档位。上游 API 不提供 context window，用户只能手填；只放最常命中的两档，
 * 其余走「自定义」直接填 token 数。
 */
export const COMMON_CONTEXT_WINDOWS: Array<{ tokens: number; label: string }> = [
  { tokens: 192_000, label: "192K" },
  { tokens: 256_000, label: "256K" },
  { tokens: 1_000_000, label: "1M" },
];

const CUSTOM = "custom";

interface ContextWindowFieldProps {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  /** 未设置时下拉框显示的文案，如「未设置」「跟随默认」。 */
  unsetLabel: string;
}

export default function ContextWindowField({ value, onChange, unsetLabel }: ContextWindowFieldProps) {
  const isCommon = value != null && COMMON_CONTEXT_WINDOWS.some((option) => option.tokens === value);
  // null 表示使用下拉档位；字符串同时承载自定义模式和输入草稿，确保清空输入时不会立刻
  // 退出自定义模式。
  const [customDraft, setCustomDraft] = useState<string | null>(value != null && !isCommon ? String(value) : null);
  const draftMatchesValue =
    customDraft !== null && ((customDraft === "" && value == null) || Number(customDraft) === value);
  // 弹窗先挂载、再从 provider 同步表单值，因此最新 value 是自定义值时直接回显，不能只
  // 依赖 useState 初始化。匹配当前值的 draft 则表示用户主动进入了自定义模式。
  const customInput = draftMatchesValue ? customDraft : value != null && !isCommon ? String(value) : null;

  const options = [
    { value: "", label: unsetLabel },
    ...COMMON_CONTEXT_WINDOWS.map((option) => ({ value: String(option.tokens), label: option.label })),
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
      {/* 用 text 而非 number：number 会带上下步进箭头，这里按档位调没有意义，用户是直接
          填一个具体的 token 数（如 192000）。 */}
      {customInput !== null && (
        <input
          type="text"
          inputMode="numeric"
          value={customInput}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, "");
            setCustomDraft(digits);
            onChange(digits ? Number(digits) : undefined);
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
