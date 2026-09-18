import { useEffect, useRef, useState } from "react";
import type { ClipboardApi } from "../../../shared/clipboard-api";
import type { LauncherApi, SearchResponse } from "../../../shared/launcher-api";
import { ClipboardPage } from "./ClipboardPage";
import { LauncherSearchBar } from "./LauncherSearchBar";
import { SearchResultList } from "./SearchResultList";

export function Launcher({ api = window.launcher, clipboardApi }: { api?: LauncherApi; clipboardApi?: ClipboardApi }) {
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchResponse>({ token: 0, hits: [] });
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [icons, setIcons] = useState<Record<string, string>>({});
  const revision = useRef(0);
  const executing = useRef(false);
  const pending = useRef(false);

  function changeQuery(value: string) {
    revision.current += 1;
    setQuery(value);
    pending.current = true;
    if (!value.trim()) setResponse({ token: 0, hits: [] });
    setSelected(0);
    setError("");
  }
  useEffect(() => {
    let active = true;
    const current = revision.current;
    api
      .search(query)
      .then((result) => {
        if (active && current === revision.current) {
          pending.current = false;
          setResponse(result);
          setSelected(0);
        }
      })
      .catch(() => {
        if (active && current === revision.current) {
          pending.current = false;
          setResponse({ token: 0, hits: [] });
          setError("搜索失败，请重试");
        }
      });
    return () => {
      active = false;
    };
  }, [query, api]);
  useEffect(() => {
    api.resize(error ? 1 : response.hits.length, clipboardOpen ? "clipboard" : undefined);
  }, [response.hits.length, error, api, clipboardOpen]);
  useEffect(() => {
    let active = true;
    for (const hit of response.hits) {
      if (hit.provider !== "app") continue;
      api
        .icon(response.token, hit.id)
        .then((data) => {
          if (active && data) setIcons((previous) => ({ ...previous, [hit.id]: data }));
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [response, api]);

  async function execute(index: number) {
    const hit = response.hits[index];
    if (!hit || pending.current || executing.current) return;
    executing.current = true;
    try {
      const destination = await api.execute(response.token, hit.id);
      if (destination === "clipboard") setClipboardOpen(true);
      changeQuery("");
    } catch {
      setError("执行失败，请重试");
    } finally {
      executing.current = false;
    }
  }
  if (clipboardOpen)
    return <ClipboardPage onHide={() => api.hide()} api={clipboardApi} onBack={() => setClipboardOpen(false)} />;
  return (
    <div className="h-screen">
      <LauncherSearchBar
        query={query}
        onQueryChange={changeQuery}
        onDismiss={() => api.hide()}
        onNavigate={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setSelected((index) => Math.max(0, Math.min(response.hits.length - 1, index + delta)));
          } else if (event.key === "Enter") {
            event.preventDefault();
            void execute(selected);
          }
        }}
      >
        {error ? (
          <div role="alert" className="px-6 py-3 text-sm text-muted">
            {error}
          </div>
        ) : (
          <SearchResultList
            hits={response.hits}
            selected={selected}
            icons={icons}
            onSelect={setSelected}
            onConfirm={execute}
          />
        )}
      </LauncherSearchBar>
    </div>
  );
}
