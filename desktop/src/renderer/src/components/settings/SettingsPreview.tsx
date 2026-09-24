// Storybook fixture adapter. Product code must use the view components with its own data and callbacks.
import { useEffect, useState } from "react";
import { AboutSettings } from "./AboutSettings";
import { AgentSettings, type AgentValues } from "./AgentSettings";
import { type ArchivedSession, ArchiveSettings } from "./ArchiveSettings";
import { type CleanupStatus, ClipboardSettings, type ClipboardValues } from "./ClipboardSettings";
import { type AccountView, GeneralSettings, type GeneralValues } from "./GeneralSettings";
import {
  type DownloadState,
  type LocalModel,
  ModelSettings,
  type ModelSettingsProps,
  type ModelValues,
  type Provider,
} from "./ModelSettings";
import SettingsLayout, { type TabId } from "./SettingsLayout";
import { ShortcutSettings, type Shortcuts } from "./ShortcutSettings";

const providersFixture: Provider[] = [
  {
    id: "deepseek",
    preset: "deepseek",
    name: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "openai-completions",
    transport: "auto",
    hasApiKey: true,
    models: ["deepseek-chat", "deepseek-reasoner"],
    modelContextWindows: {},
    modelContextLimits: {},
  },
  {
    id: "demo",
    preset: null,
    name: "demo",
    baseUrl: "https://models.example.test/v1",
    protocol: "openai-responses",
    transport: "auto",
    hasApiKey: true,
    models: ["demo-text", "demo-image"],
    modelContextWindows: {},
    modelContextLimits: {},
  },
];
const localFixture: LocalModel[] = [
  { id: "small", name: "Qwen3 4B", disk: 2.6, memory: 4.5, recommendation: "最平衡", state: "ready", progress: 100 },
  { id: "medium", name: "Qwen3 8B", disk: 5.1, memory: 8.2, recommendation: "最智能", state: "missing", progress: 0 },
  {
    id: "large",
    name: "Qwen3 32B",
    disk: 19.2,
    memory: 24.5,
    recommendation: "高内存占用",
    state: "missing",
    progress: 0,
  },
  { id: "huge", name: "Qwen3 72B", disk: 43, memory: null, recommendation: "不推荐", state: "missing", progress: 0 },
];
const sessionsFixture: ArchivedSession[] = [
  { id: "1", title: "整理本周的开发事项", workspace: "个人空间", time: "3 天前", kind: "home" },
  { id: "2", title: "搜索与剪贴板交互讨论", workspace: "XiaoWei", time: "5 天前", kind: "folder" },
  { id: "3", title: "项目知识库：架构与模块边界", workspace: "知识库", time: "1 周前", kind: "wiki" },
];
export interface PreviewProps {
  initialTab?: TabId;
  phaseOne?: boolean;
  loading?: boolean;
  accountStatus?: AccountView["status"];
  loggedIn?: boolean;
  loginWaiting?: boolean;
  loginError?: boolean;
  longText?: boolean;
  noShortcuts?: boolean;
  clipboardDisabled?: boolean;
  localEnabled?: boolean;
  storageRefreshing?: boolean;
  cleanup?: CleanupStatus;
  emptyModels?: boolean;
  providerWithoutKey?: boolean;
  localState?: DownloadState;
  initialModelDialog?: ModelSettingsProps["initialDialog"];
  imageTesting?: boolean;
  modelFetch?: "loading" | "empty" | "error" | "metadata";
  searchConfigured?: boolean;
  initialSearchEditor?: string;
  operationFailure?: boolean;
  archiveEmpty?: boolean;
  archiveLoading?: boolean;
  archiveLong?: boolean;
  archiveNoMatches?: boolean;
  initialArchiveDelete?: boolean;
  development?: boolean;
  noVersion?: boolean;
  highlighted?: boolean;
}
const delay = (milliseconds = 350) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
export function SettingsPreview(props: PreviewProps) {
  const [tab, setTab] = useState<TabId>(props.initialTab ?? "general");
  const [toast, setToast] = useState("");
  const [general, setGeneral] = useState<GeneralValues>({ theme: "system", autostart: false, bookmarks: true });
  const [account, setAccount] = useState<AccountView>({
    loggedIn: props.loggedIn ?? true,
    loggingIn: props.loginWaiting,
    nickname: props.longText ? "很长的用户昵称用于核对账号区域截断行为".repeat(4) : "示例用户",
    uin: "10000001",
    status: props.accountStatus ?? "connected",
    error: props.loginError ? "登录失败，请重新尝试" : undefined,
    avatar: `data:image/svg+xml,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">' +
        '<rect width="40" height="40" rx="20" fill="#00c572"/>' +
        '<text x="20" y="27" text-anchor="middle" fill="white" font-size="22">微</text></svg>',
    )}`,
  });
  const [shortcuts, setShortcuts] = useState<Shortcuts>(
    props.noShortcuts
      ? { search: null, chat: null, clipboard: null }
      : { search: ["Meta", "Space"], chat: ["Meta", "Shift", "Space"], clipboard: ["Meta", "Shift", "KeyX"] },
  );
  const [clipboard, setClipboard] = useState<ClipboardValues>({
    enabled: !props.clipboardDisabled,
    autoPaste: false,
    retention: 30,
  });
  const [refreshing, setRefreshing] = useState(props.storageRefreshing ?? false);
  const [cleanup, setCleanup] = useState<CleanupStatus>(props.cleanup ?? "idle");
  const [providers, setProviders] = useState<Provider[]>(() =>
    props.emptyModels
      ? []
      : structuredClone(providersFixture).map((p) => ({ ...p, hasApiKey: !props.providerWithoutKey })),
  );
  const [models, setModels] = useState<ModelValues>({
    defaultModel: props.emptyModels ? "" : "deepseek/deepseek-chat",
    smallModel: props.emptyModels ? "" : "deepseek/deepseek-chat",
    reasoning: "medium",
    imageModel: "",
    localEnabled: props.localEnabled ?? false,
    localModel: "small",
  });
  const [locals, setLocals] = useState<LocalModel[]>(() =>
    localFixture.map((m, index) => ({
      ...m,
      state: index === 0 ? (props.localState ?? m.state) : m.state,
      progress: props.localState === "downloading" ? 42 : m.progress,
      failure: "下载连接中断，请重试",
    })),
  );
  const [highlight, setHighlight] = useState(props.highlighted ?? false);
  const [agent, setAgent] = useState<AgentValues>({
    maxCalls: 50,
    source: props.searchConfigured ? "tavily" : "bing",
    configured: props.searchConfigured ? ["tavily", "brave", "serper"] : [],
  });
  const [sessions, setSessions] = useState<ArchivedSession[]>(() =>
    props.archiveEmpty
      ? []
      : props.archiveLong
        ? Array.from({ length: 30 }, (_, i) => ({
            ...sessionsFixture[i % 3],
            id: String(i),
            title: `${i + 1} · ${sessionsFixture[i % 3].title}`,
          }))
        : structuredClone(sessionsFixture),
  );
  const [archiveDays, setArchiveDays] = useState(7);
  const [deleteDays, setDeleteDays] = useState(0);
  useEffect(() => {
    if (!highlight || tab !== "llm") return;
    document.getElementById("settings-local-model")?.scrollIntoView({ block: "nearest" });
  }, [highlight, tab]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  async function operation() {
    await delay();
    if (props.operationFailure) throw new Error("操作失败：模拟服务不可用，请重试");
  }
  function page() {
    switch (tab) {
      case "general":
        return (
          <GeneralSettings
            values={general}
            account={account}
            showAccount={!props.phaseOne}
            onChange={(next) => {
              setGeneral(next);
              if (next.theme !== general.theme) document.documentElement.dataset.theme = next.theme;
            }}
            onLogin={() => {
              setAccount({ ...account, loggingIn: true, error: undefined });
              void delay().then(() =>
                setAccount({
                  ...account,
                  loggedIn: !props.operationFailure,
                  loggingIn: false,
                  error: props.operationFailure ? "登录失败，请重新尝试" : undefined,
                }),
              );
            }}
            onLogout={() => setAccount({ ...account, loggedIn: false })}
            onCopy={() => setToast("已复制 UIN（预览）")}
          />
        );
      case "shortcut":
        return <ShortcutSettings values={shortcuts} onChange={setShortcuts} showQuickChat={!props.phaseOne} />;
      case "clipboard":
        return (
          <ClipboardSettings
            values={clipboard}
            onChange={setClipboard}
            localModelEnabled={models.localEnabled}
            showImageExtraction={!props.phaseOne}
            onOpenModels={() => {
              setTab("llm");
              setHighlight(true);
            }}
            storageBytes={cleanup === "done" ? 33554432 : 134217728}
            cleanup={cleanup}
            onCleanup={() => {
              setCleanup("cleaning");
              void delay().then(() => setCleanup(props.operationFailure ? "error" : "done"));
            }}
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void delay(500).then(() => setRefreshing(false));
            }}
          />
        );
      case "llm":
        return (
          <ModelSettings
            values={models}
            providers={providers}
            localModels={locals}
            diskGB={2.6}
            onChange={setModels}
            initialDialog={props.initialModelDialog}
            highlightLocal={highlight}
            imageTesting={props.imageTesting}
            onTestImage={operation}
            onOpenDirectory={() => setToast("打开模型目录（预览）")}
            onSelectLocal={(id) => {
              setModels({ ...models, localModel: id });
              setLocals(
                locals.map((m) =>
                  m.id === id && m.state !== "ready" ? { ...m, state: "downloading", progress: 0 } : m,
                ),
              );
            }}
            onFetchModels={async (provider) => {
              if (props.modelFetch === "loading") return new Promise(() => {});
              await delay();
              if (props.modelFetch === "error") throw new Error("获取模型失败，请检查地址、协议和 API Key 后重试");
              if (props.modelFetch === "empty") return [];
              const ids =
                provider.preset === "deepseek" ? ["deepseek-chat", "deepseek-reasoner"] : ["demo-text", "demo-image"];
              return ids.map((id, index) => ({
                id,
                contextWindow: props.modelFetch === "metadata" && index === 0 ? 128000 : undefined,
              }));
            }}
            onSaveProvider={async (provider, key) => {
              await operation();
              const saved = {
                ...provider,
                id: provider.id || `provider-${providers.length + 1}`,
                hasApiKey: provider.hasApiKey || !!key,
              };
              setProviders((current) => [...current.filter((p) => p.id !== saved.id), saved]);
              return saved;
            }}
            onDeleteProvider={async (id) => {
              await operation();
              setProviders((current) => current.filter((p) => p.id !== id));
              const provider = providers.find((item) => item.id === id);
              if (provider) {
                const keep = (model: string) => (model.startsWith(`${provider.name}/`) ? "" : model);
                setModels((current) => ({
                  ...current,
                  defaultModel: keep(current.defaultModel),
                  smallModel: keep(current.smallModel),
                  imageModel: keep(current.imageModel),
                }));
              }
            }}
          />
        );
      case "agent":
        return (
          <AgentSettings
            values={agent}
            onChange={setAgent}
            onTest={operation}
            onSaveKey={operation}
            initialEditor={props.initialSearchEditor}
            highlight={props.highlighted}
            onOpenUrl={(url) => setToast(`打开 ${url}（预览）`)}
          />
        );
      case "archive":
        return (
          <ArchiveSettings
            archiveDays={archiveDays}
            deleteDays={deleteDays}
            onChange={(a, d) => {
              setArchiveDays(a);
              setDeleteDays(d);
            }}
            sessions={sessions}
            loading={props.archiveLoading ?? false}
            initialQuery={props.archiveNoMatches ? "不存在的会话" : ""}
            initialDelete={props.initialArchiveDelete ? "1" : undefined}
            onRestore={(id) => {
              setSessions(sessions.filter((s) => s.id !== id));
              setToast("已恢复对话（预览）");
            }}
            onDelete={(id) => setSessions(sessions.filter((s) => s.id !== id))}
          />
        );
      case "about":
        return (
          <AboutSettings
            version={props.noVersion ? "" : "0.1.0"}
            development={props.development ?? false}
            onCheckUpdate={() => setToast("检查更新（预览）")}
            showCheckUpdate={!props.phaseOne}
          />
        );
    }
  }
  return (
    <div className="relative h-screen min-h-[400px] w-full">
      {/* Native window controls are decorative in the browser preview. */}
      <div aria-hidden="true" className="pointer-events-none absolute top-2.5 left-3 z-10 flex gap-2">
        <span className="size-3 rounded-full border border-black/10 bg-[#ff5f57]" />
        <span className="size-3 rounded-full border border-black/10 bg-[#febc2e]" />
        <span className="size-3 rounded-full border border-black/10 bg-[#28c840]" />
      </div>
      <SettingsLayout
        activeTab={tab}
        loading={props.loading}
        availableTabs={props.phaseOne ? ["general", "shortcut", "clipboard", "about"] : undefined}
        onNavigate={(next) => {
          setTab(next);
          setHighlight(false);
        }}
      >
        {page()}
      </SettingsLayout>
      {toast && (
        <div
          role="status"
          className="absolute bottom-5 left-1/2 z-[250] max-w-[80%] -translate-x-1/2 rounded-lg bg-elevated px-4
              py-2 text-[13px] shadow-lg"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
