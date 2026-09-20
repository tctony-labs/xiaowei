import { create, fromBinary } from "@bufbuild/protobuf";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  EmptySchema,
  LauncherMode,
  LauncherOpenedSchema,
  LauncherQueryRequestSchema,
  ResultRequestSchema,
  UpdateLayoutRequestSchema,
} from "xiaowei-contracts";
import type { Subscription } from "xiaowei-gateway";
import type { SearchResponse } from "../../../shared/launcher-model";
import { services as defaultServices, type Services } from "../services";
import { ClipboardPage } from "./ClipboardPage";
import { LauncherSearchBar } from "./LauncherSearchBar";
import { SearchResultList } from "./SearchResultList";

export function Launcher({ services = defaultServices }: { services?: Services }) {
  const api = services.getLauncher();
  const gateway = services.getGateway();
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchResponse>({ token: 0, hits: [] });
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const resizing = useRef(Promise.resolve());
  const revision = useRef(0);
  const executing = useRef(false);
  const pending = useRef(false);

  const changeQuery = useCallback((value: string) => {
    revision.current += 1;
    setQuery(value);
    pending.current = true;
    if (!value.trim()) setResponse({ token: 0, hits: [] });
    setSelected(0);
    setError("");
  }, []);
  useEffect(() => {
    let active = true;
    let subscription: Subscription | undefined;
    void gateway
      .subscribe(
        LauncherOpenedSchema.typeName,
        undefined,
        (bytes) => {
          if (!active) return;
          const { mode } = fromBinary(LauncherOpenedSchema, bytes);
          if (mode !== LauncherMode.SEARCH && mode !== LauncherMode.CLIPBOARD) return;
          const nextClipboardOpen = mode === LauncherMode.CLIPBOARD;
          if (nextClipboardOpen !== clipboardOpen) changeQuery("");
          setClipboardOpen(nextClipboardOpen);
        },
        true,
      )
      .then((handle) => {
        if (active) subscription = handle;
        else handle.close();
      })
      .catch((error) => {
        if (active) console.error("Launcher subscription failed", error);
      });
    return () => {
      active = false;
      subscription?.close();
    };
  }, [gateway, clipboardOpen, changeQuery]);
  useEffect(() => {
    let active = true;
    const current = revision.current;
    api
      .query(create(LauncherQueryRequestSchema, { query }))
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
    const request = create(UpdateLayoutRequestSchema, {
      resultCount: error ? 1 : response.hits.length,
      mode: clipboardOpen ? LauncherMode.CLIPBOARD : LauncherMode.SEARCH,
    });
    resizing.current = resizing.current
      .then(async () => {
        await api.updateLayout(request);
      })
      .catch((error) => console.error("Launcher resize failed", error));
  }, [response.hits.length, error, api, clipboardOpen]);

  function hide() {
    void api.hide(create(EmptySchema)).catch((error) => console.error("Launcher hide failed", error));
  }

  function resetPosition() {
    void api.resetPosition(create(EmptySchema)).catch((error) => console.error("Launcher position failed", error));
  }

  async function execute(index: number) {
    const hit = response.hits[index];
    if (!hit || pending.current || executing.current) return;
    executing.current = true;
    try {
      const { mode: destination } = await api.execute(
        create(ResultRequestSchema, { token: response.token, id: hit.id }),
      );
      if (destination === LauncherMode.CLIPBOARD) setClipboardOpen(true);
      changeQuery("");
    } catch {
      setError("执行失败，请重试");
    } finally {
      executing.current = false;
    }
  }
  if (clipboardOpen)
    return (
      <ClipboardPage
        onHide={hide}
        onResetPosition={resetPosition}
        services={services}
        onBack={() => setClipboardOpen(false)}
      />
    );
  return (
    <div className="h-screen">
      <LauncherSearchBar
        query={query}
        onQueryChange={changeQuery}
        onDismiss={hide}
        onResetPosition={resetPosition}
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
          <SearchResultList hits={response.hits} selected={selected} onSelect={setSelected} onConfirm={execute} />
        )}
      </LauncherSearchBar>
    </div>
  );
}
