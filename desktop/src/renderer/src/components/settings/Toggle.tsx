interface ToggleProps {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  size?: "default" | "small";
  ariaLabel?: string;
}

/** iOS 风格 Toggle 开关 */
export default function Toggle({ checked, onChange, disabled = false, size = "default", ariaLabel }: ToggleProps) {
  const isSmall = size === "small";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex shrink-0 items-center rounded-full transition-colors ${
        isSmall ? "h-[16px] w-[28px]" : "h-[22px] w-[40px]"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"} ${checked ? "bg-primary" : "settings-fill"}`}
    >
      <span
        className={`inline-block rounded-full bg-white shadow-sm transition-transform ${
          isSmall
            ? `h-[12px] w-[12px] ${checked ? "translate-x-[14px]" : "translate-x-[2px]"}`
            : `h-[18px] w-[18px] ${checked ? "translate-x-[20px]" : "translate-x-[2px]"}`
        }`}
      />
    </button>
  );
}
