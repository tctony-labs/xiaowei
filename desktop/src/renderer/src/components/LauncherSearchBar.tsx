import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import logo from "../../../../resources/logo-clear.png";

export interface LauncherSearchBarProps {
  query: string;
  onQueryChange(query: string): void;
  onDismiss(): void;
  children?: ReactNode;
  leading?: ReactNode;
  placeholder?: string;
  onCompositionChange?(composing: boolean): void;
  onNavigate?(event: KeyboardEvent<HTMLInputElement>): void;
}

export function LauncherSearchBar({
  query,
  onQueryChange,
  onDismiss,
  children,
  onNavigate,
  leading,
  placeholder = "输入搜索内容",
  onCompositionChange,
}: LauncherSearchBarProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = () => {
      input.current?.focus();
      input.current?.select();
    };
    focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);

  return (
    <main className="h-full w-full overflow-hidden bg-transparent px-1 py-0.5">
      <div className="launcher-card relative flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface">
        <div aria-hidden="true" className="launcher-drag absolute inset-x-0 top-0 h-4" />
        <div className="flex h-[65px] shrink-0 items-center gap-2 pl-6 pr-4">
          <div className="flex min-h-8 min-w-0 flex-1 items-center gap-2">
            {leading}
            <input
              ref={input}
              type="text"
              aria-label="搜索"
              placeholder={placeholder}
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              onCompositionStart={() => onCompositionChange?.(true)}
              onCompositionEnd={() => onCompositionChange?.(false)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                onNavigate?.(event);
                if (!event.defaultPrevented && event.key === "Escape") {
                  event.preventDefault();
                  onQueryChange("");
                  onDismiss();
                }
              }}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-base leading-6 text-ink outline-none placeholder:text-muted"
            />
          </div>
          <img src={logo} alt="XiaoWei" draggable={false} className="size-8 shrink-0 select-none rounded-md" />
        </div>
        {children}
      </div>
    </main>
  );
}
