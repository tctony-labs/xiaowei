import { useEffect, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { lastReasoningLine } from "./message-blocks";

const previewComponents: Components = {
  p: ({ children }) => <span>{children}</span>,
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => <span>{alt}</span>,
};

export function AgentReasoningPreview({ text }: { text: string }) {
  return (
    <ReactMarkdown skipHtml components={previewComponents}>
      {lastReasoningLine(text)}
    </ReactMarkdown>
  );
}

export function AgentReasoning({ text, active }: { text: string; active: boolean }) {
  const details = useRef<HTMLDetailsElement>(null);
  const label = active ? "正在思考" : "思考过程";

  useEffect(() => {
    if (!active && details.current) details.current.open = false;
  }, [active]);

  return (
    <details ref={details} className="agent-reasoning">
      <summary aria-label={label} aria-busy={active}>
        <span className="agent-disclosure" aria-hidden="true">
          ›
        </span>
        <span className={`agent-reasoning-label${active ? " agent-shimmer" : ""}`}>{label}</span>
        <span className={`agent-reasoning-preview${active ? " agent-shimmer" : ""}`}>
          <AgentReasoningPreview text={text} />
        </span>
      </summary>
      <p>{text}</p>
    </details>
  );
}
