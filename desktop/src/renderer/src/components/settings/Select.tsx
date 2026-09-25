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
  iconOnly?: boolean;
  ariaLabel?: string;
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
  /** Portal 菜单使用的完整控件边界；指定时严格匹配其宽度。 */
  menuAnchorRef?: React.RefObject<HTMLElement | null>;
  menuPlacement?: "top" | "bottom";
}

export default function Select<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  iconOnly = false,
  ariaLabel,
  placeholder,
  className,
  buttonClassName,
  menuClassName,
  menuPortal = false,
  menuAnchorRef,
  menuPlacement = "bottom",
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [portalPosition, setPortalPosition] = useState<React.CSSProperties>({});
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
      const rect = (menuAnchorRef?.current ?? buttonRef.current)?.getBoundingClientRect();
      if (!rect) return;
      setPortalPosition({
        ...(menuPlacement === "top"
          ? { bottom: window.innerHeight - rect.top + 4, maxHeight: Math.max(0, rect.top - 12) }
          : { top: rect.bottom + 4 }),
        right: window.innerWidth - rect.right,
        ...(menuAnchorRef ? { width: rect.width } : { minWidth: rect.width }),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [menuPortal, open, menuAnchorRef, menuPlacement]);

  // 菜单先处理键盘，外层弹窗在 window 冒泡阶段处理未消费的事件。
  useEffect(() => {
    if (!open) return;
    const buttons = () => Array.from(menuRef.current?.querySelectorAll("button") ?? []);
    const selectedIndex = options.findIndex((option) => option.value === value);
    buttons()[Math.max(0, selectedIndex)]?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (!["Escape", "Enter", "ArrowDown", "ArrowUp"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      const items = buttons();
      const index = items.findIndex((item) => item === document.activeElement);
      if (e.key === "Enter") {
        if (index >= 0) items[index].click();
        buttonRef.current?.focus();
      } else if (items.length) {
        const next = e.key === "ArrowDown" ? index + 1 : index < 0 ? items.length - 1 : index - 1;
        items[(next + items.length) % items.length].focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, options, value]);

  return (
    <div ref={containerRef} className={`relative inline-block ${className ?? ""}`}>
      {/* 触发按钮 */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        className={`inline-flex cursor-pointer items-center gap-1 rounded-lg border bg-surface py-1 pr-2
          pl-2.5 text-[13px] leading-[18px] text-ink transition-colors disabled:cursor-not-allowed
          disabled:opacity-50 ${open ? "border-primary" : "border-line hover:border-muted"} ${buttonClassName ?? ""}`}
      >
        {!iconOnly && <span>{selectedLabel}</span>}
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
