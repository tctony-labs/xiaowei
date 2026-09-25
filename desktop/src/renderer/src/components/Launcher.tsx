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
import { launcherHeight, type SearchResponse } from "../../../shared/launcher-model";
import { services as defaultServices, type Services } from "../services";
import { ClipboardPage } from "./ClipboardPage";
import { LauncherSearchBar } from "./LauncherSearchBar";
import { QuickChatPanel } from "./quick-chat/QuickChatPanel";
import { QUICK_CHAT_TRANSITION_MS } from "./quick-chat/QuickChatTransition";
import { useQuickChat } from "./quick-chat/use-quick-chat";
import { SearchResultList } from "./SearchResultList";

export function Launcher({
  services = defaultServices,
  refreshToken = 0,
}: {
  services?: Services;
  refreshToken?: number;
}) {
  const api = services.getLauncher();
  const gateway = services.getGateway();
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const chat = useQuickChat(services);
  const lastLayoutMode = useRef(LauncherMode.SEARCH);
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
          if (![LauncherMode.SEARCH, LauncherMode.CLIPBOARD, LauncherMode.QUICK_CHAT].includes(mode)) return;
          setChatOpen(mode === LauncherMode.QUICK_CHAT);
          if (mode !== LauncherMode.QUICK_CHAT) setChatExpanded(false);
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
    const current = `${revision.current}:${refreshToken}`;
    api
      .query(create(LauncherQueryRequestSchema, { query }))
      .then((result) => {
        if (active && current === `${revision.current}:${refreshToken}`) {
          pending.current = false;
          setResponse(result);
          setSelected(0);
        }
      })
      .catch(() => {
        if (active && current === `${revision.current}:${refreshToken}`) {
          pending.current = false;
          setResponse({ token: 0, hits: [] });
          setError("搜索失败，请重试");
        }
      });
    return () => {
      active = false;
    };
  }, [query, api, refreshToken]);
  useEffect(() => {
    let disposed = false;
    const mode = clipboardOpen ? LauncherMode.CLIPBOARD : chatOpen ? LauncherMode.QUICK_CHAT : LauncherMode.SEARCH;
    const shrinking = lastLayoutMode.current === LauncherMode.QUICK_CHAT && mode === LauncherMode.SEARCH;
    const request = create(UpdateLayoutRequestSchema, { resultCount: error ? 1 : response.hits.length, mode });
    const apply = () => {
      resizing.current = resizing.current
        .then(async () => {
          if (disposed) return;
          await api.updateLayout(request);
          lastLayoutMode.current = mode;
          if (!disposed && mode === LauncherMode.QUICK_CHAT) setChatExpanded(true);
        })
        .catch((error) => {
          console.error("Launcher resize failed", error);
          if (!disposed && mode === LauncherMode.QUICK_CHAT) {
            setChatOpen(false);
            setError("打开快速对话失败，请重试");
          }
        });
    };
    // First enlarge the native window; when leaving chat, allow its closing transition to finish.
    const timer = shrinking ? setTimeout(apply, QUICK_CHAT_TRANSITION_MS) : undefined;
    if (!shrinking) apply();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [response.hits.length, error, api, clipboardOpen, chatOpen]);

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
    return <ClipboardPage onResetPosition={resetPosition} services={services} onBack={() => setClipboardOpen(false)} />;
  const search = (
    <LauncherSearchBar
      embedded
      query={query}
      onQueryChange={changeQuery}
      onDismiss={hide}
      onResetPosition={resetPosition}
      onNavigate={(event) => {
        if (event.key === "ArrowDown" && !query.trim()) {
          event.preventDefault();
          setChatOpen(true);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
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
  );
  return (
    <QuickChatPanel
      {...chat}
      expanded={chatExpanded}
      search={search}
      searchHeight={launcherHeight(error ? 1 : response.hits.length)}
      onCollapse={() => {
        setChatExpanded(false);
        setChatOpen(false);
      }}
    />
  );
}
