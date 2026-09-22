import { create } from "@bufbuild/protobuf";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClipboardCategoryRequestSchema,
  ClipboardChangedSchema,
  ClipboardItemRequestSchema,
  ClipboardKind,
  ClipboardListOptionsSchema,
  ClipboardResourceRequestSchema,
  CopyResourcePathRequestSchema,
  EditTextRequestSchema,
  EmptySchema,
  FavoriteRequestSchema,
  OpenUrlRequestSchema,
  SaveCategoryRequestSchema,
  SetCategoryRequestSchema,
  SetRemarkRequestSchema,
} from "xiaowei-contracts";
import type { Subscription } from "xiaowei-gateway";
import type { ClipboardCategory, ClipboardItem } from "../../../shared/clipboard-model";
import { services as defaultServices, type Services } from "../services";
import { ClipboardPanel, type ClipboardView } from "./ClipboardPanel";

export function ClipboardPage({
  onBack,
  onResetPosition,
  services = defaultServices,
  onHide,
}: {
  onBack(): void;
  onResetPosition?(): void;
  services?: Services;
  onHide(): void;
}) {
  const api = services.getClipboard();
  const system = services.getSystem();
  const gateway = services.getGateway();
  const subscriptionReady = useRef(false);
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
  const snapshot = useRef<{ query: string; view: ClipboardView; items: ClipboardItem[] } | undefined>(undefined);
  const refresh = useCallback(async () => {
    if (!subscriptionReady.current) return;
    const request = ++version.current;
    setLoading(true);
    try {
      const categoryRows = (await api.categories(create(EmptySchema))).items.map(
        ({ $typeName: _, id, ...category }) => ({ ...category, id: String(id) }),
      );
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
        const page = (
          await api.list(
            create(ClipboardListOptionsSchema, {
              query: searchQuery,
              favoritesOnly: view === "favorites",
              kind: view === "image" ? ClipboardKind.IMAGE : view === "file" ? ClipboardKind.FILE : undefined,
              categoryId: !["all", "favorites", "image", "file"].includes(view) ? BigInt(view) : undefined,
              limit: 50,
              offset,
            }),
          )
        ).items.map(
          ({ $typeName: _, id, categoryId, kind, previewText, createdAtMs, lastUsedAtMs, ...item }): ClipboardItem => ({
            ...item,
            id: String(id),
            kind: kind === ClipboardKind.IMAGE ? "image" : kind === ClipboardKind.FILE ? "file" : "text",
            text: previewText,
            createdAt: Number(createdAtMs),
            lastUsedAt: Number(lastUsedAtMs),
            categoryId: categoryId === undefined ? undefined : String(categoryId),
          }),
        );
        if (request !== version.current) return;
        rows.push(...page);
        if (page.length < 50) break;
      }
      const previous = snapshot.current;
      const first = rows[0];
      const previousFirst = first && previous?.items.find((item) => item.id === first.id);
      const selectLatest =
        previous?.query === searchQuery &&
        previous?.view === view &&
        first &&
        (!previousFirst || first.lastUsedAt > previousFirst.lastUsedAt || first.useCount > previousFirst.useCount);
      snapshot.current = { query: searchQuery, view, items: rows };

      setContentVersion((value) => value + 1);
      setItems([...new Map(rows.map((item) => [item.id, item])).values()]);
      setSelectedId((id) => (selectLatest || !rows.some((item) => item.id === id) ? rows[0]?.id : id));
      setError("");
    } catch {
      if (request === version.current) setError("读取剪贴板失败，请重新进入重试");
    } finally {
      if (request === version.current) setLoading(false);
    }
  }, [api, searchQuery, view]);
  useEffect(() => {
    let active = true;
    let subscription: Subscription | undefined;
    subscriptionReady.current = false;
    void gateway
      .subscribe(
        ClipboardChangedSchema.typeName,
        undefined,
        () => {
          if (active && subscriptionReady.current) void refresh();
        },
        true,
      )
      .then((handle) => {
        if (!active) {
          handle.close();
          return;
        }
        subscription = handle;
        subscriptionReady.current = true;
        void refresh();
      })
      .catch(() => {
        if (active) {
          setLoading(false);
          setError("读取剪贴板失败，请重新进入重试");
        }
      });
    return () => {
      active = false;
      subscriptionReady.current = false;
      ++version.current;
      subscription?.close();
    };
  }, [gateway, refresh]);
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
          const bytes = (await api.readImage(create(ClipboardItemRequestSchema, { id: BigInt(id) }))).png;
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
            const bytes = (await api.readImage(create(ClipboardItemRequestSchema, { id: BigInt(id) }))).png;
            if (!active) return;
            url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
            setPreview({ id, image: url });
          } else {
            const text =
              selectedKind === "file"
                ? undefined
                : (await api.readText(create(ClipboardItemRequestSchema, { id: BigInt(id) }))).text;
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
            () => {
              const request = create(ClipboardResourceRequestSchema, { id: BigInt(id), index });
              if (action === "open") return api.openResource(request);
              if (action === "reveal") return api.revealResource(request);
              return api.copyResourcePath(
                create(CopyResourcePathRequestSchema, {
                  id: BigInt(id),
                  index,
                  directory: action === "copyDirectory",
                }),
              );
            },
            action === "copyPath" || action === "copyDirectory" ? "路径已复制" : "",
          )
        }
        onOpenUrl={(url) => void act(() => system.openUrl(create(OpenUrlRequestSchema, { url })), "")}
        categories={categories}
        onReadText={async (id) => (await api.readText(create(ClipboardItemRequestSchema, { id: BigInt(id) }))).text}
        onEditText={async (id, text) => {
          const item = await api.editText(create(EditTextRequestSchema, { id: BigInt(id), text }));
          await refresh();
          setSelectedId(String(item.id));
        }}
        onSetRemark={async (id, remark) => {
          await api.setRemark(create(SetRemarkRequestSchema, { id: BigInt(id), remark }));
          await refresh();
        }}
        onSetCategory={async (id, category) => {
          await api.setCategory(
            create(SetCategoryRequestSchema, {
              id: BigInt(id),
              categoryId: category === undefined ? undefined : BigInt(category),
            }),
          );
          await refresh();
        }}
        onSaveCategory={async (name, color, id) => {
          await api.saveCategory(
            create(SaveCategoryRequestSchema, { name, color, id: id === undefined ? undefined : BigInt(id) }),
          );
          await refresh();
        }}
        onDeleteCategory={async (id) => {
          await api.deleteCategory(create(ClipboardCategoryRequestSchema, { id: BigInt(id) }));
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
            await api.copy(create(ClipboardItemRequestSchema, { id: BigInt(id) }));
            onHide();
          }, "")
        }
        onCopy={(id) => void act(() => api.copy(create(ClipboardItemRequestSchema, { id: BigInt(id) })), "已复制")}
        onFavorite={(id, favorite) =>
          void act(
            () => api.setFavorite(create(FavoriteRequestSchema, { id: BigInt(id), favorite })),
            favorite ? "已收藏" : "已取消收藏",
          )
        }
        onDelete={(id) => void act(() => api.delete(create(ClipboardItemRequestSchema, { id: BigInt(id) })), "已删除")}
      />
    </div>
  );
}
