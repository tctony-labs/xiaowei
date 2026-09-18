import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardApi, ClipboardCategory, ClipboardItem } from "../../../shared/clipboard-api";
import { ClipboardPanel, type ClipboardView } from "./ClipboardPanel";

export function ClipboardPage({
  onBack,
  onResetPosition,
  api = window.clipboardHistory,
  onHide = () => window.launcher.hide(),
}: {
  onBack(): void;
  onResetPosition?(): void;
  api?: ClipboardApi;
  onHide?(): void;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ClipboardView>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [composing, setComposing] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [categories, setCategories] = useState<ClipboardCategory[]>([]);
  const [contentVersion, setContentVersion] = useState(0);
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<{ id?: string; text?: string; image?: string }>({});
  const version = useRef(0);
  const operation = useRef(false);
  const refresh = useCallback(async () => {
    const request = ++version.current;
    setLoading(true);
    try {
      const categoryRows = await api.categories();
      if (request !== version.current) return;
      setCategories(categoryRows);
      if (
        !["all", "favorites", "image", "file"].includes(view) &&
        !categoryRows.some((category) => category.id === view)
      ) {
        setView("all");
        return;
      }
      const rows: ClipboardItem[] = [];
      // API pages are capped at 100; reload the visible range to preserve recent-use ordering.
      for (let offset = 0; offset < 200; offset += 50) {
        const page = await api.list({
          query: searchQuery,
          favoritesOnly: view === "favorites",
          kind: view === "image" || view === "file" ? view : undefined,
          categoryId: !["all", "favorites", "image", "file"].includes(view) ? view : undefined,
          limit: 50,
          offset,
        });
        if (request !== version.current) return;
        rows.push(...page);
        if (page.length < 50) break;
      }
      setContentVersion((value) => value + 1);
      setItems([...new Map(rows.map((item) => [item.id, item])).values()]);
      setSelectedId((id) => (rows.some((item) => item.id === id) ? id : rows[0]?.id));
      setError("");
    } catch {
      if (request === version.current) setError("读取剪贴板失败，请重新进入重试");
    } finally {
      if (request === version.current) setLoading(false);
    }
  }, [api, searchQuery, view]);
  useEffect(() => {
    void refresh();
    const unsubscribe = api.onChanged(() => void refresh());
    return () => {
      ++version.current;
      unsubscribe();
    };
  }, [api, refresh]);
  useEffect(() => {
    if (composing) return;
    if (!query.trim()) {
      setSearchQuery("");
      return;
    }
    const timer = setTimeout(() => setSearchQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query, composing]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 1500);
    return () => clearTimeout(timer);
  }, [message]);
  const imageIds = items
    .filter((item) => item.kind === "image")
    .map((item) => item.id)
    .join(",");
  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    setThumbnails({});
    void (async () => {
      for (const id of imageIds.split(",").filter(Boolean)) {
        try {
          const bytes = await api.readImage(id);
          if (!active) return;
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
          urls.push(url);
          setThumbnails((previous) => ({ ...previous, [id]: url }));
        } catch {
          /* Unavailable images retain the old generic image icon. */
        }
      }
    })();
    return () => {
      active = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [api, imageIds]);
  const selectedKind = items.find((item) => item.id === selectedId)?.kind;
  // biome-ignore lint/correctness/useExhaustiveDependencies: edits can change full text without changing the item ID
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    setPreview({});
    if (selectedId && selectedKind) {
      const id = selectedId;
      const load = async () => {
        try {
          if (selectedKind === "image") {
            const bytes = await api.readImage(id);
            if (!active) return;
            url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
            setPreview({ id, image: url });
          } else {
            const text = selectedKind === "file" ? undefined : await api.readText(id);
            if (active) setPreview({ id, text });
          }
        } catch {
          if (active) {
            setPreview({ id });
            setError("加载预览失败，请重新选择记录重试");
          }
        }
      };
      void load();
    }
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, selectedId, selectedKind, contentVersion]);

  async function act(action: () => Promise<unknown>, success: string) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setMessage("");
    try {
      await action();
      await refresh();
      setMessage(success);
    } catch {
      setError("操作失败，请重试（文件可能已移除）");
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="h-screen">
      <ClipboardPanel
        onResource={(id, action, index) =>
          void act(
            () => api.resource(id, action, index),
            action === "copyPath" || action === "copyDirectory" ? "路径已复制" : "",
          )
        }
        onOpenUrl={(url) => void act(() => api.openUrl(url), "")}
        categories={categories}
        onReadText={api.readText}
        onEditText={async (id, text) => {
          const item = await api.editText(id, text);
          await refresh();
          setSelectedId(item.id);
        }}
        onSetRemark={async (id, remark) => {
          await api.setRemark(id, remark);
          await refresh();
        }}
        onSetCategory={async (id, category) => {
          await api.setCategory(id, category);
          await refresh();
        }}
        onSaveCategory={async (name, color, id) => {
          await api.saveCategory(name, color, id);
          await refresh();
        }}
        onDeleteCategory={async (id) => {
          await api.deleteCategory(id);
          await refresh();
        }}
        items={items}
        selectedId={selectedId}
        query={query}
        view={view}
        thumbnails={thumbnails}
        onCompositionChange={setComposing}
        loading={loading}
        busy={busy}
        error={error}
        message={message}
        previewText={preview.id === selectedId ? preview.text : undefined}
        previewImage={preview.id === selectedId ? preview.image : undefined}
        previewLoading={Boolean(selectedId && preview.id !== selectedId)}
        onQueryChange={(value) => {
          setQuery(value);
        }}
        onViewChange={(value) => {
          setView(value);
          setSelectedId(undefined);
        }}
        onSelect={setSelectedId}
        onBack={onBack}
        onResetPosition={onResetPosition}
        onActivate={(id) =>
          void act(async () => {
            await api.copy(id);
            onHide();
          }, "")
        }
        onCopy={(id) => void act(() => api.copy(id), "已复制")}
        onFavorite={(id, favorite) => void act(() => api.setFavorite(id, favorite), favorite ? "已收藏" : "已取消收藏")}
        onDelete={(id) => void act(() => api.delete(id), "已删除")}
      />
    </div>
  );
}
