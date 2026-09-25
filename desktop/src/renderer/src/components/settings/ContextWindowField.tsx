import { useRef } from "react";
import { COMMON_CONTEXT_WINDOWS } from "./context-window-presets";
import Select from "./Select";

interface ContextWindowFieldProps {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  /** 输入为空时的占位文案。 */
  unsetLabel: string;
  suggestedValue?: number;
  presets?: Array<{ tokens: number; label: string }>;
  customLabel?: string;
}

export default function ContextWindowField({
  value,
  onChange,
  unsetLabel,
  presets = COMMON_CONTEXT_WINDOWS,
  suggestedValue,
  customLabel = "上下文窗口大小",
}: ContextWindowFieldProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const choices = [...presets];
  if (suggestedValue != null && !choices.some((option) => option.tokens === suggestedValue)) {
    const label = suggestedValue % 1000 === 0 ? `${suggestedValue / 1000}K` : suggestedValue.toLocaleString();
    choices.push({ tokens: suggestedValue, label });
    choices.sort((a, b) => a.tokens - b.tokens);
  }
  const options = choices.map((option) => ({ value: String(option.tokens), label: option.label }));

  return (
    <div
      ref={anchorRef}
      className="flex shrink-0 items-center rounded-lg border border-line bg-surface focus-within:border-primary"
    >
      <input
        type="text"
        inputMode="numeric"
        aria-label={customLabel}
        value={value ?? ""}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "");
          const tokens = Number(digits);
          onChange(digits && Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined);
        }}
        placeholder={unsetLabel}
        className="w-[calc(8ch+0.75rem)] bg-transparent py-1 pl-1.5 pr-0.5 text-right text-[13px] tabular-nums
          text-ink outline-none placeholder:text-muted"
      />
      <Select
        options={options}
        value={value == null ? "" : String(value)}
        onChange={(next) => onChange(Number(next))}
        iconOnly
        ariaLabel={`选择${customLabel}`}
        className="shrink-0"
        buttonClassName="!border-0 !rounded-l-none !pl-1.5 !pr-1.5"
        menuAnchorRef={anchorRef}
        menuPlacement="top"
        menuPortal
      />
    </div>
  );
}
