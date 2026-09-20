import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ClipboardItem, ClipboardResourceAction } from "../../../shared/clipboard-model";
import { type ClipboardDialog, type ClipboardEditing, ClipboardEditors } from "./ClipboardEditors";
import {
  AddCircleIcon,
  ImageIcon as CategoryImageIcon,
  ChevronIcon,
  ClipIcon,
  CopyIcon,
  FavoriteIcon,
  FilesIcon,
  OpenFileMenuIcon,
  RemarkIcon,
  RevealMenuIcon,
  StarIcon,
  TagIcon,
  TextEditIcon,
  TrashIcon,
} from "./ClipboardIcons";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { FILE_ICON_COLORS, FileIcon, getFileIconType, ImageIcon, LargeFileIcon, TextIcon } from "./FileTypeIcon";
import { LauncherSearchBar } from "./LauncherSearchBar";
import Modal, { ModalButton } from "./Modal";

export type ClipboardView = string;
const views = [
  { id: "favorites", label: "收藏", Icon: StarIcon },
  { id: "all", label: "剪贴板", Icon: ClipIcon },
  { id: "image", label: "图片", Icon: CategoryImageIcon },
  { id: "file", label: "文件", Icon: FilesIcon },
] as const;

export interface ClipboardPanelProps extends ClipboardEditing {
  items: ClipboardItem[];
  onResource(id: string, action: ClipboardResourceAction, index?: number): void;
  onOpenUrl(url: string): void;
  selectedId?: string;
  query: string;
  view: ClipboardView;
  loading?: boolean;
  busy?: boolean;
  error?: string;
  message?: string;
  previewText?: string;
  previewImage?: string;
  thumbnails?: Record<string, string>;
  previewLoading?: boolean;
  onQueryChange(value: string): void;
  onCompositionChange?(composing: boolean): void;
  onViewChange(value: ClipboardView): void;
  onSelect(id: string): void;
  onActivate(id: string): void;
  onCopy(id: string): void;
  onFavorite(id: string, value: boolean): void;
  onDelete(id: string): void;
  onBack(): void;
  onResetPosition?(): void;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return text;
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).map((part, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: immutable text segments
    <span key={index} className={index % 2 ? "text-primary-text" : undefined}>
      {part}
    </span>
  ));
}

function EmptyIcon({ preview = false }: { preview?: boolean }) {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true" className="text-faint">
      {preview ? (
        <>
          <rect x="6" y="8" width="28" height="32" rx="3" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M14 20h12M14 26h8M38 16v20a4 4 0 01-4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="36" cy="14" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M36 11v6M33 14h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : (
        <>
          <rect x="8" y="6" width="32" height="36" rx="4" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M16 6V4a2 2 0 012-2h12a2 2 0 012 2v2M16 20h16M16 27h10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

function Thumbnail({ item, image }: { item: ClipboardItem; image?: string }) {
  if (item.kind === "image")
    return image ? <img src={image} alt="" className="size-5 shrink-0 rounded-[5px] object-cover" /> : <ImageIcon />;
  if (item.kind !== "file") return <TextIcon />;
  const type = getFileIconType(item.paths[0] ?? "");
  return type === "image" ? <ImageIcon /> : <FileIcon color={FILE_ICON_COLORS[type]} />;
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-[3px] text-xs leading-[18px]">
      <span className="shrink-0 whitespace-nowrap text-muted">{label}</span>
      <span className="min-w-0 truncate text-ink-secondary" title={value}>
        {value}
      </span>
    </div>
  );
}

export function ClipboardPanel(props: ClipboardPanelProps) {
  const selected = props.items.find((item) => item.id === props.selectedId);
  const list = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const [renderedId, setRenderedId] = useState<string>();
  const [dialog, setDialog] = useState<ClipboardDialog>();
  const [fileMenu, setFileMenu] = useState<{ x: number; y: number; id: string; index: number }>();
  const [categoryMenu, setCategoryMenu] = useState<{ x: number; y: number; id: string }>();
  const allViews = [...views.map((view) => view.id as string), ...props.categories.map((category) => category.id)];
  const [collapsed, setCollapsed] = useState(true);
  const [deleteId, setDeleteId] = useState<string>();
  const [menu, setMenu] = useState<{ x: number; y: number; item: ClipboardItem }>();
  useEffect(() => {
    const scroll = () => {
      const container = list.current;
      const row = props.selectedId ? rows.current.get(props.selectedId) : undefined;
      if (!container || !row) return;
      const bounds = container.getBoundingClientRect();
      const item = row.getBoundingClientRect();
      if (item.top < bounds.top + 8) container.scrollTop -= bounds.top + 8 - item.top;
      else if (item.bottom > bounds.bottom - 8) container.scrollTop += item.bottom - (bounds.bottom - 8);
    };
    scroll();
    window.addEventListener("focus", scroll);
    return () => window.removeEventListener("focus", scroll);
  }, [props.selectedId]);

  function navigate(event: KeyboardEvent<HTMLElement>) {
    if (
      menu ||
      fileMenu ||
      categoryMenu ||
      dialog ||
      deleteId ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    if (event.key === "Escape" || (event.key === "Backspace" && !props.query)) {
      event.preventDefault();
      props.onBack();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = props.items.findIndex((item) => item.id === props.selectedId);
      const next = Math.max(0, Math.min(props.items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      if (props.items[next]) props.onSelect(props.items[next].id);
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !props.query) {
      event.preventDefault();
      const index = allViews.indexOf(props.view);
      props.onViewChange(allViews[(index + (event.key === "ArrowLeft" ? allViews.length - 1 : 1)) % allViews.length]);
    } else if (event.key === "Enter" && selected && !props.busy) {
      event.preventDefault();
      props.onActivate(selected.id);
    }
  }

  const [mutationError, setMutationError] = useState("");
  async function assign(id: string, category?: string) {
    try {
      await props.onSetCategory(id, category);
      setMutationError("");
    } catch {
      setMutationError("设置分类失败，请重试");
    }
  }
  const iconButton =
    "flex items-center justify-center p-1.5 rounded text-ink-secondary " +
    "hover:text-ink hover:bg-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
  function resourceEntries(item: ClipboardItem): MenuItem[] {
    if (item.kind !== "image" && item.kind !== "file") return [];
    const single = item.kind === "image" || item.paths.length === 1;
    return [
      { key: "divider-resource", label: "" },
      ...(single
        ? [{ key: "open", label: "打开", icon: <OpenFileMenuIcon />, onClick: () => props.onResource(item.id, "open") }]
        : []),
      {
        key: "reveal",
        label: "在文件夹中查看",
        icon: <RevealMenuIcon />,
        onClick: () => props.onResource(item.id, "reveal"),
      },
    ];
  }
  function copyChildren(item: ClipboardItem): MenuItem[] | undefined {
    if (item.kind !== "image" && item.kind !== "file") return undefined;
    const image = item.kind === "image";
    const single = image || item.paths.length === 1;
    const directories = item.paths.map((path) => path.slice(0, path.lastIndexOf("/")) || "/");
    const common = image || directories.every((directory) => directory === directories[0]);
    return [
      {
        key: "copy-content",
        label: image ? "图片" : single ? "文件" : "全部文件",
        onClick: () => props.onCopy(item.id),
      },
      ...(single
        ? [
            {
              key: "copy-path",
              label: image ? "图片路径" : "文件路径",
              onClick: () => props.onResource(item.id, "copyPath"),
            },
          ]
        : []),
      ...(common
        ? [{ key: "copy-dir", label: "文件夹路径", onClick: () => props.onResource(item.id, "copyDirectory") }]
        : []),
    ];
  }
  const contextItems: MenuItem[] = menu
    ? [
        {
          key: "copy",
          label: "复制",
          icon: <CopyIcon />,
          disabled: props.busy,
          onClick: () => props.onCopy(menu.item.id),
          children: copyChildren(menu.item),
        },
        ...resourceEntries(menu.item),
        { key: "divider1", label: "" },
        {
          key: "favorite",
          label: menu.item.favorite ? "取消收藏" : "收藏",
          icon: <FavoriteIcon filled={menu.item.favorite} />,
          disabled: props.busy,
          onClick: () => props.onFavorite(menu.item.id, !menu.item.favorite),
        },
        {
          key: "remark",
          label: "备注",
          icon: <RemarkIcon />,
          onClick: () => setDialog({ type: "remark", item: menu.item }),
        },
        {
          key: "category",
          label: "分类",
          icon: <TagIcon />,
          children: [
            { key: "none", label: "无分类", onClick: () => void assign(menu.item.id) },
            ...props.categories.map((category) => ({
              key: category.id,
              label: category.name,
              onClick: () => void assign(menu.item.id, category.id),
            })),
          ],
        },
        { key: "divider2", label: "" },
        {
          key: "delete",
          label: "删除",
          icon: <TrashIcon />,
          danger: true,
          disabled: props.busy,
          onClick: () => setDeleteId(menu.item.id),
        },
      ]
    : [];
  const directories = selected?.paths.map((path) => path.slice(0, path.lastIndexOf("/")) || "/") ?? [];
  const commonDirectory =
    directories.length && directories.every((dir) => dir === directories[0]) ? directories[0] : undefined;
  const text = props.previewText ?? selected?.text ?? "";
  let formattedJson: string | undefined;
  if (selected?.kind === "text") {
    try {
      formattedJson = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* Plain text or Markdown. */
    }
  }
  const showRendered = renderedId === selected?.id;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: launcher mode keyboard delegation
    <div
      className="h-full"
      onKeyDown={(event) => {
        if (!event.defaultPrevented) navigate(event);
      }}
    >
      <LauncherSearchBar
        onResetPosition={props.onResetPosition}
        query={props.query}
        onQueryChange={props.onQueryChange}
        onCompositionChange={props.onCompositionChange}
        placeholder=""
        onDismiss={props.onBack}
        onNavigate={navigate}
        leading={
          <div className="flex h-7 max-w-[240px] shrink-0 select-none items-center gap-1 rounded-lg bg-hover px-2 py-1 text-xs leading-none text-ink-secondary">
            <ClipIcon size={14} />
            <span className="truncate">剪切板</span>
          </div>
        }
      >
        <nav
          aria-label="剪贴板视图"
          className="relative flex shrink-0 items-center gap-2 overflow-x-auto border-t border-subtle py-3 pl-3 pr-6"
        >
          {views.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              tabIndex={-1}
              aria-pressed={props.view === id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onViewChange(id)}
              className={`flex h-8 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-3 outline-none ${
                props.view === id ? "bg-clipboard-selected" : "hover:bg-hover"
              }`}
            >
              <Icon size={16} />
              <span className="text-sm leading-[22px]">{label}</span>
            </button>
          ))}
          {props.categories.length > 0 && (
            <div className="h-5 shrink-0 px-1">
              <div className="h-full w-px bg-line" />
            </div>
          )}
          {props.categories.map((category) => (
            <button
              key={category.id}
              type="button"
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onViewChange(category.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setCategoryMenu({ x: event.clientX, y: event.clientY, id: category.id });
              }}
              aria-pressed={props.view === category.id}
              className={`flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm ${props.view === category.id ? "bg-clipboard-selected" : "hover:bg-hover"}`}
            >
              <TagIcon size={16} color={category.color} />
              {category.name}
            </button>
          ))}
          <div className="absolute inset-y-0 right-0 flex items-center bg-gradient-to-l from-surface from-70% to-transparent pl-6 pr-6">
            <button
              type="button"
              onClick={() => setDialog({ type: "category" })}
              title="新建分类"
              aria-label="新建分类"
              className="flex size-8 items-center justify-center rounded-md text-ink-secondary disabled:opacity-40"
            >
              <AddCircleIcon size={16} />
            </button>
          </div>
        </nav>
        <div className="flex min-h-0 flex-1">
          <div
            ref={list}
            role="listbox"
            aria-label="剪贴板记录"
            aria-busy={props.loading}
            className="flex w-[312px] shrink-0 flex-col gap-1 overflow-y-auto border-t border-line px-3.5 py-2"
          >
            {!props.items.length && (
              <div
                className="flex flex-1 items-center justify-center"
                role="status"
                aria-label={props.loading ? "加载中" : "暂无记录"}
              >
                {props.loading ? <span className="text-sm text-muted">加载中...</span> : <EmptyIcon />}
              </div>
            )}
            {props.items.map((item) => (
              <div
                key={item.id}
                role="option"
                tabIndex={0}
                aria-selected={item.id === props.selectedId}
                ref={(element) => {
                  if (element) rows.current.set(item.id, element);
                  else rows.current.delete(item.id);
                }}
                onClick={() => props.onSelect(item.id)}
                onKeyDown={navigate}
                onDoubleClick={() => {
                  if (!props.busy) props.onActivate(item.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  props.onSelect(item.id);
                  setMenu({ x: event.clientX, y: event.clientY, item });
                }}
                className={`relative flex shrink-0 cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 text-left ${
                  item.id === props.selectedId ? "bg-clipboard-selected" : ""
                }`}
              >
                {item.categoryId && item.categoryId !== props.view && (
                  <span className="absolute right-0.5 top-0.5">
                    <TagIcon
                      size={10}
                      color={props.categories.find((category) => category.id === item.categoryId)?.color}
                    />
                  </span>
                )}
                <div className="flex h-10 min-w-0 flex-1 items-center gap-2">
                  <Thumbnail item={item} image={props.thumbnails?.[item.id]} />
                  <div className="flex min-w-0 flex-1 flex-col justify-center">
                    <p className="truncate text-sm leading-[22px]">
                      <Highlight
                        query={props.query}
                        text={
                          item.kind === "image"
                            ? "图片"
                            : item.kind === "file"
                              ? item.paths.map((path) => path.split("/").pop()).join(", ")
                              : (item.text ?? "").replace(/\n/g, " ").trim()
                        }
                      />
                    </p>
                    {item.remark && (
                      <p className="truncate text-[11px] leading-[14px] text-muted">
                        <Highlight text={item.remark} query={props.query} />
                      </p>
                    )}
                  </div>
                </div>
                {item.favorite && (
                  <button
                    type="button"
                    title="取消收藏"
                    aria-label="取消收藏"
                    disabled={props.busy}
                    className="shrink-0 cursor-pointer"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onFavorite(item.id, false);
                    }}
                  >
                    <FavoriteIcon filled />
                  </button>
                )}
              </div>
            ))}
          </div>
          <section
            aria-label="内容预览"
            className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-t border-line"
          >
            {selected ? (
              <>
                <div className="min-h-0 flex-1 overflow-auto">
                  {props.previewLoading ? (
                    <p className="p-5 text-sm text-muted">加载中...</p>
                  ) : selected.kind === "image" ? (
                    <div className="flex h-full items-center justify-center px-5 pt-5">
                      {props.previewImage && (
                        <img
                          src={props.previewImage}
                          alt="剪贴板图片"
                          className="max-h-full max-w-full rounded-lg object-contain"
                        />
                      )}
                    </div>
                  ) : selected.kind === "file" ? (
                    <div className="flex flex-col gap-2 px-5 pt-5">
                      {commonDirectory && (
                        <p className="mb-1 break-all text-xs font-semibold leading-[18px]">
                          <Highlight text={commonDirectory} query={props.query} />
                        </p>
                      )}
                      {selected.paths.length > 1 && (
                        <p className="text-xs text-muted">共 {selected.paths.length} 个文件</p>
                      )}
                      {selected.paths.map((path, index) => (
                        <button
                          key={path}
                          type="button"
                          className="flex cursor-pointer items-center gap-3 rounded-lg bg-hover px-3 py-2.5 text-left"
                          onClick={(event) =>
                            setFileMenu({ x: event.clientX, y: event.clientY, id: selected.id, index })
                          }
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setFileMenu({ x: event.clientX, y: event.clientY, id: selected.id, index });
                          }}
                        >
                          <LargeFileIcon path={path} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium leading-5">{path.split("/").pop()}</p>
                            {!commonDirectory && <p className="break-all text-[11px] leading-4 text-muted">{path}</p>}
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : showRendered ? (
                    formattedJson ? (
                      <pre className="m-3 whitespace-pre-wrap break-words rounded-lg bg-hover p-2 text-sm">
                        <Highlight text={formattedJson} query={props.query} />
                      </pre>
                    ) : (
                      <div className="clipboard-markdown break-words p-5 text-sm leading-[22px] text-ink-secondary">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            a: ({ href, children }) => (
                              <a
                                href={href}
                                className="cursor-pointer text-primary-text hover:underline"
                                onClick={(event) => {
                                  event.preventDefault();
                                  if (href) props.onOpenUrl(href);
                                }}
                              >
                                {children}
                              </a>
                            ),
                            img: ({ src, alt }) =>
                              src && /^https?:\/\//i.test(src) ? (
                                <img
                                  src={src}
                                  alt={alt ?? ""}
                                  referrerPolicy="no-referrer"
                                  className="max-w-full rounded-lg"
                                />
                              ) : (
                                <span>{alt}</span>
                              ),
                          }}
                        >
                          {text}
                        </ReactMarkdown>
                      </div>
                    )
                  ) : (
                    <div className="flex h-full flex-col gap-4 px-5 pt-5 text-sm leading-[22px] text-ink-secondary">
                      {(selected.previewTruncated ? (selected.text ?? "") : text)
                        .split("\n\n")
                        .map((paragraph, index) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: text paragraphs are immutable
                          <p key={index} className="whitespace-pre-wrap break-words">
                            <Highlight text={paragraph} query={props.query} />
                          </p>
                        ))}
                      {selected.previewTruncated && <p className="text-[13px] text-muted">...还有{text.length}字</p>}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2 border-b border-subtle px-5 py-2.5">
                  {selected.kind === "text" && (
                    <>
                      <button
                        type="button"
                        className="cursor-pointer text-sm leading-[22px] text-primary-text"
                        onClick={() => setRenderedId(showRendered ? undefined : selected.id)}
                      >
                        {showRendered ? "查看原始文本" : formattedJson ? "查看JSON" : "查看MARKDOWN"}
                      </button>
                      <div className="h-[18px] w-px bg-subtle" />
                    </>
                  )}
                  {selected.previewTruncated && (
                    <>
                      <button
                        type="button"
                        disabled={props.busy}
                        onClick={() => props.onResource(selected.id, "open")}
                        className="text-sm leading-[22px] text-primary-text disabled:opacity-40"
                      >
                        查看全部文本
                      </button>
                      <div className="h-[18px] w-px bg-subtle" />
                    </>
                  )}
                  <div className="flex-1" />
                  <div className="flex items-center gap-2">
                    {selected.kind === "text" && (
                      <button
                        type="button"
                        onClick={() => setDialog({ type: "text", item: selected })}
                        title="编辑"
                        aria-label="编辑"
                        className={iconButton}
                      >
                        <TextEditIcon />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setDialog({ type: "remark", item: selected })}
                      title="备注"
                      aria-label="备注"
                      className={iconButton}
                    >
                      <RemarkIcon />
                    </button>
                    <button
                      type="button"
                      disabled={props.busy}
                      title={selected.favorite ? "取消收藏" : "收藏"}
                      aria-label={selected.favorite ? "取消收藏" : "收藏"}
                      className={iconButton}
                      onClick={() => props.onFavorite(selected.id, !selected.favorite)}
                    >
                      <FavoriteIcon filled={selected.favorite} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDialog({ type: "assign", item: selected })}
                      title="分类"
                      aria-label="分类"
                      className={iconButton}
                    >
                      <TagIcon size={18} />
                    </button>
                    <button
                      type="button"
                      disabled={props.busy}
                      title="删除"
                      aria-label="删除"
                      className={`${iconButton} hover:text-danger`}
                      onClick={() => setDeleteId(selected.id)}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col px-5 pb-5 pt-5">
                  <div className="flex items-center justify-between py-px">
                    <span className="text-xs font-semibold leading-[18px]">详细信息</span>
                    <button
                      type="button"
                      onClick={() => setCollapsed(!collapsed)}
                      aria-expanded={!collapsed}
                      className="flex cursor-pointer items-center gap-1 rounded py-0.5 text-xs leading-[18px] text-primary-text"
                    >
                      <span>{collapsed ? "展开" : "收起"}</span>
                      <ChevronIcon collapsed={collapsed} />
                    </button>
                  </div>
                  {!collapsed && (
                    <div className="flex flex-col">
                      {selected.categoryId && (
                        <MetaRow
                          label="分类"
                          value={
                            props.categories.find((category) => category.id === selected.categoryId)?.name ?? "未知"
                          }
                        />
                      )}
                      <MetaRow label="上次使用" value={new Date(selected.lastUsedAt).toLocaleString("sv-SE")} />
                      <MetaRow label="使用次数" value={String(selected.useCount)} />
                      {selected.kind === "text" && <MetaRow label="文本长度" value={`${text.length} 字符`} />}
                      {selected.kind === "image" && (
                        <MetaRow label="图片尺寸" value={`${selected.width} × ${selected.height}`} />
                      )}
                      {selected.kind === "file" && (
                        <MetaRow
                          label={selected.paths.length === 1 ? "文件路径" : "文件数量"}
                          value={selected.paths.length === 1 ? selected.paths[0] : `${selected.paths.length} 个文件`}
                        />
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center" role="status" aria-label="无预览">
                <EmptyIcon preview />
              </div>
            )}
          </section>
        </div>
        {(props.error || mutationError || props.message) && (
          <div
            role={props.error ? "alert" : "status"}
            className="pointer-events-none absolute inset-x-0 bottom-[124px] z-[300] flex justify-center"
          >
            <span className="rounded-lg bg-black/75 px-4 py-2 text-[13px] leading-5 text-white shadow-lg">
              {props.error || mutationError || props.message}
            </span>
          </div>
        )}
      </LauncherSearchBar>
      {dialog && (
        <ClipboardEditors
          key={dialog.type + ("item" in dialog ? dialog.item.id : (dialog.category?.id ?? "new"))}
          {...props}
          dialog={dialog}
          onClose={() => setDialog(undefined)}
        />
      )}
      {fileMenu && (
        <ContextMenu
          x={fileMenu.x}
          y={fileMenu.y}
          onClose={() => setFileMenu(undefined)}
          items={[
            { key: "open", label: "打开", onClick: () => props.onResource(fileMenu.id, "open", fileMenu.index) },
            {
              key: "reveal",
              icon: <RevealMenuIcon />,
              label: "在文件夹中查看",
              onClick: () => props.onResource(fileMenu.id, "reveal", fileMenu.index),
            },
            { key: "divider", label: "" },
            {
              key: "copy-path",
              label: "复制路径",
              onClick: () => props.onResource(fileMenu.id, "copyPath", fileMenu.index),
            },
            {
              key: "copy-dir",
              label: "复制文件夹路径",
              onClick: () => props.onResource(fileMenu.id, "copyDirectory", fileMenu.index),
            },
          ]}
        />
      )}
      {categoryMenu && (
        <ContextMenu
          x={categoryMenu.x}
          y={categoryMenu.y}
          onClose={() => setCategoryMenu(undefined)}
          items={[
            {
              key: "edit",
              label: "编辑",
              onClick: () => {
                const category = props.categories.find((value) => value.id === categoryMenu.id);
                if (category) setDialog({ type: "category", category });
              },
            },
            { key: "divider", label: "" },
            {
              key: "delete",
              label: "删除",
              danger: true,
              onClick: () => {
                const category = props.categories.find((value) => value.id === categoryMenu.id);
                if (category) setDialog({ type: "deleteCategory", category });
              },
            },
          ]}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={contextItems} onClose={() => setMenu(undefined)} />}
      <Modal
        open={Boolean(deleteId)}
        title="确认删除"
        onClose={() => setDeleteId(undefined)}
        onConfirm={() => {
          if (deleteId && !props.busy) {
            props.onDelete(deleteId);
            setDeleteId(undefined);
          }
        }}
        footer={
          <>
            <ModalButton onClick={() => setDeleteId(undefined)}>取消</ModalButton>
            <ModalButton
              variant="danger"
              disabled={props.busy}
              onClick={() => {
                if (deleteId) {
                  props.onDelete(deleteId);
                  setDeleteId(undefined);
                }
              }}
            >
              删除
            </ModalButton>
          </>
        }
      >
        <p className="text-[13px] leading-5 text-ink-secondary">确定要删除这条记录吗？此操作不可撤销。</p>
      </Modal>
    </div>
  );
}
