import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface SelectOption<T extends string | number> {
  value: T;
  label: string;
}

interface SelectProps<T extends string | number> {
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** 当前值不在 options 中时显示的占位文案。 */
  placeholder?: string;
  /** 外层容器样式。 */
  className?: string;
  /** 触发按钮样式。 */
  buttonClassName?: string;
  /** 自定义菜单宽度/样式，如 "w-[100px]" */
  menuClassName?: string;
  /** 将菜单渲染到 body，避免撑开祖先滚动容器。 */
  menuPortal?: boolean;
}

export default function Select<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  placeholder,
  className,
  buttonClassName,
  menuClassName,
  menuPortal = false,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [portalPosition, setPortalPosition] = useState({ top: 0, right: 0, minWidth: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? placeholder ?? "";

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !menuPortal) return;
    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPortalPosition({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
        minWidth: rect.width,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [menuPortal, open]);

  // Escape 关闭
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <div ref={containerRef} className={`relative inline-block ${className ?? ""}`}>
      {/* 触发按钮 */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={`inline-flex cursor-pointer items-center gap-1 rounded-lg border bg-surface py-1 pr-2
          pl-2.5 text-[13px] leading-[18px] text-ink transition-colors disabled:cursor-not-allowed
          disabled:opacity-50 ${open ? "border-primary" : "border-line hover:border-muted"} ${buttonClassName ?? ""}`}
      >
        <span>{selectedLabel}</span>
        <svg
          className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* 下拉菜单 */}
      {open &&
        (menuPortal ? (
          createPortal(
            <SelectMenu
              innerRef={menuRef}
              options={options}
              value={value}
              onSelect={(next) => {
                onChange(next);
                setOpen(false);
              }}
              className={`settings-scrollbar fixed z-[200] max-h-64 overflow-y-auto ${menuClassName ?? ""}`}
              style={portalPosition}
            />,
            document.body,
          )
        ) : (
          <SelectMenu
            innerRef={menuRef}
            options={options}
            value={value}
            onSelect={(next) => {
              onChange(next);
              setOpen(false);
            }}
            className={`absolute right-0 z-50 mt-1 min-w-full ${menuClassName ?? ""}`}
          />
        ))}
    </div>
  );
}

interface SelectMenuProps<T extends string | number> {
  innerRef: React.Ref<HTMLDivElement>;
  options: SelectOption<T>[];
  value: T;
  onSelect: (value: T) => void;
  className: string;
  style?: React.CSSProperties;
}

function SelectMenu<T extends string | number>({
  innerRef,
  options,
  value,
  onSelect,
  className,
  style,
}: SelectMenuProps<T>) {
  return (
    <div
      ref={innerRef}
      style={style}
      className={`${className} rounded-lg bg-elevated p-1
          shadow-[0px_6px_16px_rgba(0,0,0,0.08),0px_3px_6px_rgba(0,0,0,0.12),0px_9px_28px_rgba(0,0,0,0.05)]`}
    >
      {options.map((opt) => {
        const isSelected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onSelect(opt.value)}
            className={`flex w-full cursor-pointer items-center whitespace-nowrap rounded-lg px-3 py-[5px]
          text-[14px] leading-[22px] transition-colors ${
            isSelected ? "bg-primary-bg font-medium text-primary-text" : "text-ink hover:bg-hover"
          }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
