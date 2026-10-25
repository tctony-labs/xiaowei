import { useEffect, useState } from "react";

interface AgentCopyButtonProps {
  text: string;
  label: string;
  onCopy: (text: string) => Promise<void>;
}

export function AgentCopyButton({ text, label, onCopy }: AgentCopyButtonProps) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 1800);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    if (state === "copying") return;
    setState("copying");
    try {
      await onCopy(text);
      setState("copied");
    } catch {
      console.warn("Agent chat clipboard write failed");
      setState("failed");
    }
  }

  const feedback = state === "copied" ? "已复制" : state === "failed" ? "复制失败，请重试" : "";

  return (
    <span className="agent-copy-control">
      <button
        type="button"
        aria-label={label}
        title={label}
        className="agent-copy-button"
        disabled={state === "copying"}
        onClick={() => void copy()}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <rect x="8" y="8" width="12" height="12" rx="2" />
          <path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4" />
        </svg>
      </button>
      {feedback && (
        <span role="status" className={state === "failed" ? "text-danger" : "text-muted"}>
          {feedback}
        </span>
      )}
    </span>
  );
}
