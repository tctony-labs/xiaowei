import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  open: boolean;
  inactive?: boolean;
  onClose: () => void;
  onConfirm?: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  showCloseButton?: boolean;
  contentClassName?: string;
}

export function hasOpenModal(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

export default function Modal({
  open,
  inactive = false,
  onClose,
  onConfirm,
  title,
  children,
  footer,
  width = "w-[360px]",
  showCloseButton = false,
  contentClassName = "px-5 py-3",
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || inactive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (e.key === "Enter" && onConfirm) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onConfirm();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, inactive, onClose, onConfirm]);

  if (!open) return null;

  // 通过 Portal 挂到 body，避免祖先（例如 SettingsLayout 内 overflow:auto 的
  // 滚动容器，或潜在的 transform/filter）对 fixed 定位形成 containing block，
  // 进而出现遮罩盖不满整窗的问题。
  return createPortal(
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal={!inactive}
      aria-hidden={inactive || undefined}
      inert={inactive}
      aria-label={title}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        className={`${width} relative flex flex-col rounded-xl bg-elevated shadow-[0px_6px_16px_rgba(0,0,0,0.08),0px_3px_6px_rgba(0,0,0,0.12),0px_9px_28px_rgba(0,0,0,0.05)]`}
      >
        {title && (
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            <span className="text-[14px] font-semibold leading-[22px] text-ink">{title}</span>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex items-center justify-center rounded p-1 text-muted transition-colors hover:text-ink hover:bg-hover cursor-pointer"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
        {!title && showCloseButton ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="absolute top-3 right-4 z-10 flex cursor-pointer items-center justify-center rounded p-1 text-muted transition-colors hover:bg-hover hover:text-ink"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
        <div className={contentClassName}>{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 px-5 pt-1 pb-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

interface ModalButtonProps {
  children: ReactNode;
  onClick: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
}

export function ModalButton({ children, onClick, variant = "default", disabled }: ModalButtonProps) {
  const base =
    "px-4 py-1.5 rounded-lg text-[13px] leading-[18px] font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";
  const variants = {
    default: "bg-hover text-ink hover:bg-hover",
    primary: "bg-primary text-white hover:bg-primary/80",
    danger: "bg-danger text-white hover:bg-danger/80",
  };
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]}`}>
      {children}
    </button>
  );
}
