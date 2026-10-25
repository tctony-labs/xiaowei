import {
  Children,
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentCopyButton } from "./AgentCopyButton";

interface AgentMarkdownProps {
  text: string;
  onCopy: (text: string) => Promise<void>;
  onOpenUrl: (url: string) => Promise<void>;
  streaming?: boolean;
}

const MarkdownActions = createContext<{
  onCopy: AgentMarkdownProps["onCopy"];
  onOpenUrl: (url: string) => void;
} | null>(null);

function MarkdownLink({ href, children }: { href?: string; children: ReactNode }) {
  const actions = useContext(MarkdownActions);
  if (!href) return <span>{children}</span>;
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        actions?.onOpenUrl(href);
      }}
    >
      {children}
    </a>
  );
}

// Stable component types keep code scrolling and copy feedback through streaming updates.
const markdownComponents: Components = {
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  img: ({ src, alt }) => <MarkdownLink href={src}>{alt || "图片"}</MarkdownLink>,
  table: ({ children }) => (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Wide tables need keyboard scrolling.
    <section className="agent-table-scroll" tabIndex={0} aria-label="表格">
      <table>{children}</table>
    </section>
  ),
  pre: function MarkdownCode({ children }) {
    const actions = useContext(MarkdownActions);
    const child = Children.toArray(children)[0];
    const code = isValidElement<{ children?: ReactNode; className?: string }>(child)
      ? child.props
      : undefined;
    const source = typeof code?.children === "string" ? code.children : "";
    const language = /language-([^\s]+)/.exec(code?.className ?? "")?.[1];

    return (
      <div className="agent-code-block">
        <div className="agent-code-header">
          <span>{language || "代码"}</span>
          {actions && <AgentCopyButton text={source} label="复制代码" onCopy={actions.onCopy} />}
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Code needs keyboard scrolling. */}
        <section className="agent-code-scroll" tabIndex={0} aria-label="代码块">
          <pre>{children}</pre>
        </section>
      </div>
    );
  },
};

export function AgentMarkdown({ text, onCopy, onOpenUrl, streaming = false }: AgentMarkdownProps) {
  const [linkError, setLinkError] = useState(false);

  async function openUrl(url: string) {
    setLinkError(false);
    try {
      await onOpenUrl(url);
    } catch {
      console.warn("Agent chat link open failed");
      setLinkError(true);
    }
  }

  return (
    <div className="agent-markdown" data-streaming={streaming || undefined} aria-busy={streaming}>
      <MarkdownActions.Provider value={{ onCopy, onOpenUrl: (url) => void openUrl(url) }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {text}
        </ReactMarkdown>
      </MarkdownActions.Provider>
      {linkError && (
        <p role="alert" className="text-xs text-danger">
          链接打开失败，请重试。
        </p>
      )}
    </div>
  );
}
