interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

/** 分段选择器组件 */
export default function SegmentedControl<T extends string>({ options, value, onChange }: SegmentedControlProps<T>) {
  return (
    <div className="flex rounded-lg settings-fill p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`cursor-pointer rounded-md px-3 py-1 text-[12px] leading-[16px] transition-all ${
            value === opt.value ? "bg-primary font-medium text-white shadow-sm" : "text-muted hover:text-ink-secondary"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
