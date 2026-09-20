import { useEffect, useRef } from "react";
import logo from "../../../../resources/logo-clear.png";
import type { LauncherHit } from "../../../shared/launcher-model";
import chrome from "../assets/chrome.svg";
import clipboardIcon from "../assets/clipboard.svg";
import genericApp from "../assets/macos-generic-app.png";
import settings from "../assets/macos-system-settings.png";

export interface SearchResultListProps {
  hits: LauncherHit[];
  selected: number;
  onSelect(index: number): void;
  onConfirm(index: number): void;
}

function Highlight({ hit }: { hit: LauncherHit }) {
  return Array.from(hit.title).map((char, index) => (
    <span
      // Character offsets are the stable positions supplied by the Rust matcher.
      // biome-ignore lint/suspicious/noArrayIndexKey: title characters have no independent identity
      key={index}
      className={hit.ranges.some(({ start, end }) => index >= start && index < end) ? "text-primary-text" : undefined}
    >
      {char}
    </span>
  ));
}

export function SearchResultList({ hits, selected, onSelect, onConfirm }: SearchResultListProps) {
  const container = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const list = container.current;
    const row = rows.current[selected];
    if (!list || !row) return;
    const bounds = list.getBoundingClientRect();
    const item = row.getBoundingClientRect();
    if (item.top < bounds.top + 8) list.scrollTop -= bounds.top + 8 - item.top;
    else if (item.bottom > bounds.bottom - 8) list.scrollTop += item.bottom - (bounds.bottom - 8);
  }, [selected]);
  if (!hits.length) return null;
  return (
    <div ref={container} className="min-h-0 flex-1 overflow-y-auto border-t border-line px-3.5 py-2">
      <div className="flex flex-col gap-1" role="listbox" aria-label="搜索结果">
        {hits.map((hit, index) => {
          const icon =
            hit.iconUrl ??
            (hit.provider === "command"
              ? hit.id === "command:toggle-system-theme"
                ? settings
                : hit.id === "command:clipboard"
                  ? clipboardIcon
                  : logo
              : hit.provider === "bookmark"
                ? chrome
                : hit.label === "系统设置"
                  ? settings
                  : genericApp);
          return (
            <button
              key={hit.id}
              ref={(element) => {
                rows.current[index] = element;
              }}
              type="button"
              role="option"
              aria-selected={index === selected}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(index)}
              onDoubleClick={() => onConfirm(index)}
              className={`flex h-12 shrink-0 items-center w-full cursor-pointer gap-2 rounded-lg px-2.5 text-left transition-colors ${index === selected ? "bg-primary-bg" : "hover:bg-hover"}`}
            >
              {hit.provider === "calculator" ? (
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 text-muted"
                  aria-hidden="true"
                >
                  <rect width="16" height="20" x="4" y="2" rx="2" />
                  <path d="M8 6h8M8 10h2m4 0h2M8 14h2m4 0h2M8 18h2m4 0h2" />
                </svg>
              ) : (
                <img
                  src={icon}
                  alt=""
                  onError={(event) => {
                    if (event.currentTarget.src !== new URL(genericApp, window.location.href).href) {
                      event.currentTarget.src = genericApp;
                    }
                  }}
                  className={`size-[22px] shrink-0 object-contain ${hit.provider === "app" ? "scale-125" : ""}`}
                />
              )}
              <span className="min-w-0 flex-1 truncate text-sm leading-5">
                <Highlight hit={hit} />
              </span>
              <span className="shrink-0 rounded px-1.5 py-0.5 text-xs leading-[18px] text-muted">{hit.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
