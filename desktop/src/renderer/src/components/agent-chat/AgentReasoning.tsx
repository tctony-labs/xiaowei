import ReactMarkdown, { type Components } from "react-markdown";
import { lastReasoningLine } from "./message-blocks";

const previewComponents: Components = {
  p: ({ children }) => <span>{children}</span>,
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => <span>{alt}</span>,
};

export function AgentReasoning({ text, active }: { text: string; active: boolean }) {
  const label = active ? "正在思考" : "思考过程";

  return (
    <details className="agent-reasoning">
      <summary aria-label={label} aria-busy={active}>
        <span className="agent-disclosure" aria-hidden="true">
          ›
        </span>
        <span className={`agent-reasoning-label${active ? " agent-shimmer" : ""}`}>{label}</span>
        <span className={`agent-reasoning-preview${active ? " agent-shimmer" : ""}`}>
          <ReactMarkdown skipHtml components={previewComponents}>
            {lastReasoningLine(text)}
          </ReactMarkdown>
        </span>
      </summary>
      <p>{text}</p>
    </details>
  );
}
