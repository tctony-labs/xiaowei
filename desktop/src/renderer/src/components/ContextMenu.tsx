import { type ReactNode, useEffect, useRef, useState } from "react";

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  children?: MenuItem[];
  onClick?: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose]);

  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) {
      menuRef.current.style.left = `${Math.max(0, x - rect.width)}px`;
    }
    if (rect.bottom > vh) {
      menuRef.current.style.top = `${Math.max(0, y - rect.height)}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[200] min-w-[160px] rounded-lg bg-elevated p-1 shadow-[0px_6px_16px_rgba(0,0,0,0.08),0px_3px_6px_rgba(0,0,0,0.12),0px_9px_28px_rgba(0,0,0,0.05)]"
      style={{ left: x, top: y }}
    >
      {items.map((item) => (
        <MenuItemRow key={item.key} item={item} onClose={onClose} />
      ))}
    </div>
  );
}

function MenuItemRow({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [subOpen, setSubOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!subOpen || !subRef.current || !rowRef.current) return;
    const rowRect = rowRef.current.getBoundingClientRect();
    const subRect = subRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rowRect.right + subRect.width > vw) {
      subRef.current.style.left = `${-subRect.width}px`;
    }
    if (rowRect.top + subRect.height > vh) {
      subRef.current.style.top = `${rowRect.height - subRect.height}px`;
    }
  }, [subOpen]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  if (item.key.startsWith("divider")) {
    return <div className="my-1 h-px bg-line" />;
  }

  const hasChildren = item.children && item.children.length > 0;

  const handleEnter = () => {
    if (!hasChildren) return;
    clearTimeout(timerRef.current);
    setSubOpen(true);
  };

  const handleLeave = () => {
    if (!hasChildren) return;
    timerRef.current = setTimeout(() => setSubOpen(false), 150);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover delegation for submenu open/close
    <div ref={rowRef} className="relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <button
        type="button"
        role="menuitem"
        disabled={item.disabled}
        onClick={() => {
          if (hasChildren) return;
          item.onClick?.();
          onClose();
        }}
        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-[5px] text-[13px] leading-[20px] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
          item.danger ? "text-danger hover:bg-danger/10" : "text-ink hover:bg-hover"
        }`}
      >
        {item.icon && <span className="w-4 h-4 flex items-center justify-center shrink-0">{item.icon}</span>}
        <span className="flex-1 text-left">{item.label}</span>
        {hasChildren && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
            className="shrink-0 text-muted"
          >
            <path
              d="M4.5 3l3 3-3 3"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
      {hasChildren && subOpen && (
        <div
          ref={subRef}
          className="absolute left-full top-0 min-w-[140px] rounded-lg bg-elevated p-1 shadow-[0px_6px_16px_rgba(0,0,0,0.08),0px_3px_6px_rgba(0,0,0,0.12),0px_9px_28px_rgba(0,0,0,0.05)]"
        >
          {item.children?.map((child) => (
            <MenuItemRow key={child.key} item={child} onClose={onClose} />
          ))}
        </div>
      )}
    </div>
  );
}
