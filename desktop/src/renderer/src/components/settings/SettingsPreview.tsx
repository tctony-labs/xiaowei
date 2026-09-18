// Storybook fixture adapter. Product code must use the view components with its own data and callbacks.
import { useEffect, useState } from "react";
import { AboutSettings } from "./AboutSettings";
import { AgentSettings, type AgentValues } from "./AgentSettings";
import { type ArchivedSession, ArchiveSettings } from "./ArchiveSettings";
import { ClipboardSettings, type ClipboardValues, type MigrationStatus } from "./ClipboardSettings";
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
    name: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    protocol: "openai",
    transport: "auto",
    hasApiKey: true,
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    contextWindow: 1_000_000,
    modelContextWindows: {},
  },
  {
    id: "demo",
    name: "demo",
    baseUrl: "https://models.example.test/v1",
    protocol: "responses",
    transport: "auto",
    hasApiKey: true,
    models: ["demo-text", "demo-image"],
    defaultModel: "demo-text",
    contextWindow: 256000,
    modelContextWindows: {},
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
  migration?: MigrationStatus;
  migrationEmpty?: boolean;
  emptyModels?: boolean;
  providerWithoutKey?: boolean;
  localState?: DownloadState;
  initialModelDialog?: ModelSettingsProps["initialDialog"];
  imageTesting?: boolean;
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
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 350));
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
    autoPaste: true,
    retention: 30,
  });
  const [refreshing, setRefreshing] = useState(props.storageRefreshing ?? false);
  const [migration, setMigration] = useState<MigrationStatus>(props.migration ?? "idle");
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
    providerId: props.emptyModels ? "" : "deepseek",
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
        return <ShortcutSettings values={shortcuts} onChange={setShortcuts} />;
      case "clipboard":
        return (
          <ClipboardSettings
            values={clipboard}
            onChange={setClipboard}
            localModelEnabled={models.localEnabled}
            onOpenModels={() => {
              setTab("llm");
              setHighlight(true);
            }}
            storageBytes={134217728}
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void delay().then(() => setRefreshing(false));
            }}
            migration={migration}
            migrationSummary={
              migration === "error"
                ? "迁移失败：无法读取旧版数据库"
                : props.migrationEmpty
                  ? "没有需要迁移的数据"
                  : "已迁移 3 个分类，128 条数据"
            }
            onMigrate={() => {
              setMigration("checking");
              void delay().then(async () => {
                setMigration("migrating");
                await delay();
                setMigration(props.operationFailure ? "error" : "done");
              });
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
            onSaveProvider={async (provider, key) => {
              await operation();
              const saved = {
                ...provider,
                id: provider.id || `provider-${providers.length + 1}`,
                hasApiKey: provider.hasApiKey || !!key,
                models: provider.models.length ? provider.models : ["demo-text", "demo-image"],
                defaultModel: provider.defaultModel || "demo-text",
              };
              setProviders((current) => [...current.filter((p) => p.id !== saved.id), saved]);
              return saved;
            }}
            onDeleteProvider={async (id) => {
              await operation();
              setProviders((current) => current.filter((p) => p.id !== id));
              if (models.providerId === id) setModels({ ...models, providerId: "", defaultModel: "", smallModel: "" });
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
          />
        );
    }
  }
  return (
    <div className="relative h-screen min-h-[400px] w-full">
      <SettingsLayout
        activeTab={tab}
        loading={props.loading}
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
