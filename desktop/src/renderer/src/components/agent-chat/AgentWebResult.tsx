import { type AgentToolCall, AgentToolStatus } from "proto-desktop-ts";
import { isToolObject, parseToolJson } from "./tool-presentation";
import { readWebSearch, webUrl } from "./web-presentation";

export interface AgentWebLinkProps {
  onOpenUrl?: (url: string) => void;
}

export function AgentWebResult({
  call,
  onOpenUrl,
}: {
  call: AgentToolCall;
} & AgentWebLinkProps) {
  const args = parseToolJson(call.argumentsJson);
  const validParameters = isToolObject(args);
  const parameters = validParameters ? args : {};
  const isSearch = call.name === "WebSearch";
  const search =
    isSearch && call.status === AgentToolStatus.COMPLETED
      ? readWebSearch(call.metadataJson)
      : undefined;
  const results = search?.results;
  const isFetch = call.name === "WebFetch";
  const url = isFetch && typeof parameters.url === "string" ? parameters.url : undefined;
  const prompt = isFetch && typeof parameters.prompt === "string" ? parameters.prompt : undefined;
  const query =
    isSearch && typeof parameters.query === "string" && parameters.query.trim()
      ? parameters.query
      : search?.query;
  const parameterClass =
    query === undefined ? "agent-content-scroll space-y-2" : "agent-tool-scroll space-y-2";

  function link(url: string, title: string) {
    const target = webUrl(url);
    if (!target || !onOpenUrl) return <span>{title}</span>;
    return (
      <a
        href={target}
        onClick={(event) => {
          event.preventDefault();
          onOpenUrl(target);
        }}
      >
        {title}
      </a>
    );
  }

  return (
    <div className="agent-web-result">
      {(!validParameters || url !== undefined || query !== undefined) && (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard scrolling.
        <section className={parameterClass} aria-label="网页工具参数" tabIndex={0}>
          {!validParameters && (
            <div>
              <h4>参数</h4>
              <pre>{call.argumentsJson || "无参数"}</pre>
            </div>
          )}
          {url !== undefined && <p>{link(url, url)}</p>}
          {query !== undefined && <p className="p-2">{query}</p>}
        </section>
      )}
      {prompt !== undefined && (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard scrolling.
        <section className="agent-tool-scroll" aria-label="提取指令" tabIndex={0}>
          <p className="p-2">{prompt}</p>
        </section>
      )}
      {results?.length ? (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard scrolling.
        <section className="agent-tool-scroll" aria-label="搜索结果" tabIndex={0}>
          <ol>
            {results.map((result, index) => (
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
        </section>
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard scrolling.
        <section className="agent-tool-scroll" aria-label="网页工具输出" tabIndex={0}>
          <pre>
            {call.output || (call.status === AgentToolStatus.PENDING ? "等待执行结果…" : "无结果")}
          </pre>
        </section>
      )}
    </div>
  );
}
