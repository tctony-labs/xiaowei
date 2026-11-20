import { useEffect, useRef } from "react";
import { ReasoningIcon } from "../ReasoningIcon";
import { reasoningPreview } from "./reasoning-preview";

export function AgentReasoning({ text, active }: { text: string; active: boolean }) {
  const details = useRef<HTMLDetailsElement>(null);
  const label = active ? "正在思考" : "思考过程";
  const preview = reasoningPreview(text);

  useEffect(() => {
    if (!active && details.current) details.current.open = false;
  }, [active]);

  return (
    <details ref={details} className="agent-reasoning">
      <summary aria-label={label} aria-busy={active}>
        <ReasoningIcon />
        <span className={`agent-reasoning-label${active ? " agent-shimmer" : ""}`}>{label}</span>
        {preview && (
          <span className={`agent-reasoning-preview${active ? " agent-shimmer" : ""}`}>
            {preview}
          </span>
        )}
        <span className="agent-disclosure" aria-hidden="true">
          ›
        </span>
      </summary>
      <p>{text}</p>
    </details>
  );
}
