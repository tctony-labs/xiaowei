import { useCallback, useRef, useState } from "react";

/** 快捷键值：KeyboardEvent.code 数组，如 ["Meta", "Shift", "Space"] */
export type ShortcutValue = string[];

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * 判断 KeyboardEvent.code 是否为支持的功能键
 * 支持：字母(KeyA-Z)、数字(Digit0-9)、F键(F1-F12)、Space、常见标点
 */
const SUPPORTED_CODES = new Set([
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
  "Minus",
  "Equal",
  "Backquote",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Escape",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

function isCodeSupported(code: string): boolean {
  if (code.startsWith("Key") || code.startsWith("Digit") || code.startsWith("F") || code === "Space") {
    return true;
  }
  return SUPPORTED_CODES.has(code);
}

/** 将 KeyboardEvent.code 转为显示文本 */
function displayCode(code: string): string {
  // 修饰键用 macOS 符号
  if (code === "Meta") return "⌘";
  if (code === "Control") return "⌃";
  if (code === "Alt") return "⌥";
  if (code === "Shift") return "⇧";
  // 字母键
  if (code.startsWith("Key")) return code.charAt(3);
  // 数字键
  if (code.startsWith("Digit")) return code.charAt(5);
  // F 键
  if (/^F\d+$/.test(code)) return code;

  const map: Record<string, string> = {
    Space: "Space",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Slash: "/",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Escape: "Esc",
    Home: "Home",
    End: "End",
    PageUp: "PgUp",
    PageDown: "PgDn",
  };
  return map[code] ?? code;
}

/** 将快捷键数组转为显示字符串 */
function shortcutToString(keys: ShortcutValue | null): string {
  if (!Array.isArray(keys) || keys.length === 0) return "";
  return keys.map(displayCode).join("");
}

interface ShortcutInputProps {
  value: ShortcutValue | null;
  onChange: (value: ShortcutValue | null) => void;
  placeholder?: string;
}

/** 快捷键输入框组件 — 基于 e.code 的捕获 */
export default function ShortcutInput({ value, onChange, placeholder = "录制快捷键" }: ShortcutInputProps) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [capturedKeys, setCapturedKeys] = useState<string[]>([]);
  const inputRef = useRef<HTMLDivElement>(null);

  const displayKeys = isCapturing ? capturedKeys : Array.isArray(value) ? value : [];
  const display = shortcutToString(displayKeys);

  const bindKeys = useCallback(
    (keys: string[]) => {
      onChange(keys.length > 0 ? keys : null);
      setIsCapturing(false);
      inputRef.current?.blur();
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();

      // Enter 确认当前捕获
      if (e.key === "Enter") {
        if (capturedKeys.length > 0) {
          bindKeys(capturedKeys);
        }
        return;
      }

      // Escape 取消录制
      if (e.key === "Escape") {
        setIsCapturing(false);
        inputRef.current?.blur();
        return;
      }

      // 纯修饰键按下 — 只做预览，不结束
      if (MODIFIER_KEYS.has(e.key)) {
        return;
      }

      // 过滤不支持的 code
      if (!isCodeSupported(e.code)) {
        return;
      }

      // 构建 keys 列表：修饰键 + 功能键
      const keys: string[] = [];
      if (e.metaKey) keys.push("Meta");
      if (e.ctrlKey) keys.push("Control");
      if (e.altKey) keys.push("Alt");
      if (e.shiftKey) keys.push("Shift");

      // 至少需要一个修饰键
      if (keys.length === 0) {
        return;
      }

      keys.push(e.code);
      setCapturedKeys(keys);
    },
    [bindKeys, capturedKeys],
  );

  const handleFocus = () => {
    setCapturedKeys([]);
    setIsCapturing(true);
  };

  const handleBlur = () => {
    setCapturedKeys([]);
    setIsCapturing(false);
  };

  const handleClear = () => {
    onChange(null);
    setIsCapturing(false);
  };

  // 录制中且已有按键时的提示
  const capturingHint = isCapturing && capturedKeys.length > 0;

  const hasValue = !isCapturing && Array.isArray(value) && value.length > 0;

  return (
    // biome-ignore lint/a11y/useSemanticElements: Custom keyboard shortcut capture region
    <div
      ref={inputRef}
      role="textbox"
      tabIndex={0}
      aria-label={placeholder}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className={`inline-flex h-[34px] w-[220px] items-center justify-between rounded-lg border px-3
          text-[13px] leading-[18px] transition-colors cursor-pointer select-none ${
            isCapturing ? "border-primary bg-primary/10" : "border-line bg-surface hover:border-muted"
          }`}
    >
      <div className="flex flex-1 items-center justify-center gap-1">
        {display ? (
          <span className="flex items-center gap-0.5 text-ink">
            {displayKeys.map((code) => (
              <kbd
                key={code}
                className={`rounded settings-fill px-1.5 py-0.5 leading-[16px] text-ink ${
                  code === "Shift" || code === "Meta" ? "settings-shortcut-modifier text-[10px]" : "text-[12px]"
                }`}
              >
                {displayCode(code)}
              </kbd>
            ))}
          </span>
        ) : (
          <span className="text-faint">{isCapturing ? "请按下快捷键…" : placeholder}</span>
        )}
        {capturingHint && <span className="ml-1 text-[11px] text-faint">Enter 确认</span>}
      </div>
      {hasValue && (
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleClear();
          }}
          className="-mr-1.5 shrink-0 cursor-pointer rounded p-1.5 text-faint transition-colors hover:bg-hover
              hover:text-ink-secondary"
          title="清除"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
