import { type AgentToolCall, AgentToolStatus } from "proto-desktop-ts";
import { useState } from "react";
import { AgentCopyButton } from "./AgentCopyButton";
import { isToolObject, parseToolJson } from "./tool-presentation";
import { readWebSearch, webUrl } from "./web-presentation";

export interface AgentWebCallbacks {
  onCopy?: (text: string) => Promise<void>;
  onOpenUrl?: (url: string) => Promise<void>;
}

export function AgentWebResult({
  call,
  onCopy,
  onOpenUrl,
}: {
  call: AgentToolCall;
} & AgentWebCallbacks) {
  const [error, setError] = useState("");
  const args = parseToolJson(call.argumentsJson);
  const parameters = isToolObject(args) ? args : {};
  const payload =
    call.name === "WebSearch" && call.status === AgentToolStatus.COMPLETED
      ? readWebSearch(call.metadataJson)
      : undefined;
  const fetchUrl = webUrl(parameters.url);

  function link(url: string, title: string) {
    const target = webUrl(url);
    if (!target || !onOpenUrl) return <span>{title}</span>;
    return (
      <a
        href={target}
        onClick={(event) => {
          event.preventDefault();
          setError("");
          void onOpenUrl(target).catch(() => setError("打开链接失败，请重试"));
        }}
      >
        {title}
      </a>
    );
  }

  return (
    <div className="agent-web-result">
      {!isToolObject(args) && (
        <div>
          <h4>参数</h4>
          <pre>{call.argumentsJson || "无参数"}</pre>
        </div>
      )}
      {call.name === "WebFetch" && (
        <>
          {typeof parameters.url === "string" && <p>{link(parameters.url, parameters.url)}</p>}
          {typeof parameters.prompt === "string" && <p>{parameters.prompt}</p>}
        </>
      )}
      {payload && payload.results.length > 0 ? (
        <ol>
          {payload.results.map((result, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Committed search order is immutable.
            <li key={`${index}-${result.url}`}>
              {link(result.url, result.title)}
              {webUrl(result.url) && (
                <div className="agent-web-domain">{new URL(result.url).host}</div>
              )}
              {result.snippet && <p>{result.snippet}</p>}
            </li>
          ))}
        </ol>
      ) : (
        <>
          {!fetchUrl && call.name === "WebSearch" && typeof parameters.query === "string" && (
            <p>{parameters.query}</p>
          )}
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard scrolling. */}
          <section className="agent-tool-scroll" aria-label="网页工具输出" tabIndex={0}>
            <pre>
              {call.output ||
                (call.status === AgentToolStatus.PENDING ? "等待执行结果…" : "无结果")}
            </pre>
          </section>
        </>
      )}
      {call.output && onCopy && (
        <AgentCopyButton text={call.output} label="复制工具结果" onCopy={onCopy} />
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
