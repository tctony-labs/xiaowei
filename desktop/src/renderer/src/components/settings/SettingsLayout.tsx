import type { ReactNode } from "react";
import "./settings.css";
export type TabId = "general" | "shortcut" | "clipboard" | "llm" | "agent" | "archive" | "about";
interface TabItem {
  id: TabId;
  label: string;
}
/** 齿轮图标 */
function SettingsIcon({ active }: { active: boolean }) {
  const color = active ? "#fff" : "var(--color-muted)";
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.86 1.33 a1.2 1.2 0 0 1 2.28 0 l.22.67 a1.2 1.2 0 0 0 1.52.72 l.65-.24 a1.2 1.2 0 0 1 1.61
              1.14 l-.02.7 a1.2 1.2 0 0 0 1.08 1.22 l.69.06 a1.2 1.2 0 0 1 .79 1.97 l-.46.52 a1.2 1.2 0 0 0 0
              1.62 l.46.52 a1.2 1.2 0 0 1-.79 1.97 l-.69.06 a1.2 1.2 0 0 0-1.08 1.22 l.02.7 a1.2 1.2 0 0
              1-1.61 1.14 l-.65-.24 a1.2 1.2 0 0 0-1.52.72 l-.22.67 a1.2 1.2 0 0 1-2.28 0 l-.22-.67 a1.2 1.2
              0 0 0-1.52-.72 l-.65.24 a1.2 1.2 0 0 1-1.61-1.14 l.02-.7 a1.2 1.2 0 0 0-1.08-1.22 l-.69-.06
              a1.2 1.2 0 0 1-.79-1.97 l.46-.52 a1.2 1.2 0 0 0 0-1.62 l-.46-.52 a1.2 1.2 0 0 1 .79-1.97
              l.69-.06 A1.2 1.2 0 0 0 2.88 4.5 l-.02-.7 A1.2 1.2 0 0 1 4.47 2.7 l.65.24 a1.2 1.2 0 0 0
              1.52-.72 l.22-.67 Z M8 10.5 a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5 Z"
        fill={color}
      />
    </svg>
  );
}

/** 键盘图标 */
function KeyboardIcon({ active }: { active: boolean }) {
  const color = active ? "#fff" : "var(--color-muted)";
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1" y="3.5" width="14" height="9" rx="1.5" stroke={color} strokeWidth="1.2" />
      <rect x="3.5" y="5.5" width="1.5" height="1.5" rx="0.3" fill={color} />
      <rect x="6" y="5.5" width="1.5" height="1.5" rx="0.3" fill={color} />
      <rect x="8.5" y="5.5" width="1.5" height="1.5" rx="0.3" fill={color} />
      <rect x="11" y="5.5" width="1.5" height="1.5" rx="0.3" fill={color} />
      <rect x="3.5" y="8" width="1.5" height="1.5" rx="0.3" fill={color} />
      <rect x="11" y="8" width="1.5" height="1.5" rx="0.3" fill={color} />
      <rect x="6" y="8" width="4" height="1.5" rx="0.3" fill={color} />
    </svg>
  );
}

/** 剪贴板图标 */
function ClipboardIcon({ active }: { active: boolean }) {
  const color = active ? "#fff" : "var(--color-muted)";
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="2.5" width="10" height="12" rx="1.5" stroke={color} strokeWidth="1.2" />
      <path d="M6 2.5V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v.5" stroke={color} strokeWidth="1.2" />
      <path d="M5.5 6.5h5M5.5 9h3" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** Sparkles ✦ 图标（模型） */
function SparklesIcon({ active }: { active: boolean }) {
  const color = active ? "#fff" : "var(--color-muted)";
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.5 1.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5z" fill={color} />
      <path d="M4 8l0.7 1.8L6.5 10.5l-1.8 0.7L4 13l-0.7-1.8L1.5 10.5l1.8-0.7L4 8z" fill={color} />
      <path d="M11.5 10l0.5 1.3L13.3 11.8l-1.3 0.5L11.5 13.6l-0.5-1.3L9.7 11.8l1.3-0.5L11.5 10z" fill={color} />
    </svg>
  );
}

/** 机器人 / 智能体图标 */
function BotIcon({ active }: { active: boolean }) {
  const color = active ? "#fff" : "var(--color-muted)";
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="10" height="8" rx="2" stroke={color} strokeWidth="1.2" />
      <path d="M8 3v2" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="6" cy="9" r="0.8" fill={color} />
      <circle cx="10" cy="9" r="0.8" fill={color} />
      <path d="M1.5 9h1.5M13 9h1.5" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** 归档图标 */
function ArchiveIcon({ active }: { active: boolean }) {
  const color = active ? "#fff" : "var(--color-muted)";
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="3" width="13" height="3" rx="0.8" stroke={color} strokeWidth="1.2" />
      <path d="M2.5 6v6a1.5 1.5 0 0 0 1.5 1.5h8A1.5 1.5 0 0 0 13.5 12V6" stroke={color} strokeWidth="1.2" />
      <path d="M6.5 9h3" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** 关于图标 */
function AboutIcon({ active }: { active: boolean }) {
  const color = active ? "#fff" : "var(--color-muted)";
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.2" />
      <path d="M8 7v4" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="5.25" r="0.75" fill={color} />
    </svg>
  );
}

const ICON_MAP: Record<TabId, (active: boolean) => React.ReactNode> = {
  general: (active) => <SettingsIcon active={active} />,
  shortcut: (active) => <KeyboardIcon active={active} />,
  clipboard: (active) => <ClipboardIcon active={active} />,
  llm: (active) => <SparklesIcon active={active} />,
  agent: (active) => <BotIcon active={active} />,
  archive: (active) => <ArchiveIcon active={active} />,
  about: (active) => <AboutIcon active={active} />,
};

const TABS: TabItem[] = [
  { id: "general", label: "通用" },
  { id: "shortcut", label: "快捷键" },
  { id: "clipboard", label: "剪贴板" },
  { id: "llm", label: "模型" },
  { id: "agent", label: "智能体" },
  { id: "archive", label: "对话归档" },
  { id: "about", label: "关于" },
];

export default function SettingsLayout({
  activeTab,
  onNavigate,
  children,
  loading = false,
}: {
  activeTab: TabId;
  onNavigate: (tab: TabId) => void;
  children: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="settings-layout flex h-full w-full text-ink">
      {loading ? (
        <div className="flex flex-1 items-center justify-center" role="status" aria-label="正在加载设置">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-transparent" />
        </div>
      ) : (
        <>
          <nav aria-label="设置导航" className="settings-fill flex w-[207px] shrink-0 flex-col pt-8">
            <div className="flex flex-col gap-0.5 px-2">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onNavigate(tab.id)}
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  className={`flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-[13px]
              leading-[22px] transition-colors ${
                activeTab === tab.id ? "bg-primary font-medium text-white" : "text-muted hover:bg-hover"
              }`}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {ICON_MAP[tab.id](activeTab === tab.id)}
                  </span>
                  {tab.label}
                </button>
              ))}
            </div>
          </nav>
          <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
        </>
      )}
    </div>
  );
}
