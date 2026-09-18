import { useState } from "react";
import Modal, { ModalButton } from "../Modal";
import Select from "./Select";
import SettingCard from "./SettingCard";
import SettingRow from "./SettingRow";
import SettingsTabLayout from "./SettingsTabLayout";
export const searchSources = [
  { id: "bing", name: "Bing", description: "默认搜索源，无需配置", url: "" },
  { id: "tavily", name: "Tavily", description: "专为 LLM 优化的搜索结果", url: "https://app.tavily.com/" },
  {
    id: "brave",
    name: "Brave",
    description: "独立索引，结果质量好",
    url: "https://api-dashboard.search.brave.com/app/dashboard",
  },
  { id: "serper", name: "Serper", description: "Google 搜索结果代理", url: "https://serper.dev/dashboard" },
];
export interface AgentValues {
  maxCalls: number;
  source: string;
  configured: string[];
}
export function AgentSettings({
  values,
  onChange,
  onTest,
  onSaveKey,
  onOpenUrl,
  initialEditor,
  highlight = false,
}: {
  values: AgentValues;
  onChange: (values: AgentValues) => void;
  onTest: () => Promise<void>;
  onSaveKey: (source: string, key: string) => Promise<void>;
  onOpenUrl: (url: string) => void;
  initialEditor?: string;
  highlight?: boolean;
}) {
  const [editor, setEditor] = useState(initialEditor ?? "");
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState("");
  async function test() {
    setTesting(true);
    setMessage("");
    try {
      await onTest();
      setMessage("搜索源测试成功");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }
  return (
    <SettingsTabLayout title="智能体">
      <div className={`rounded-xl ${highlight ? "ring-2 ring-primary/60" : ""}`}>
        <SettingCard>
          <SettingRow
            title="单轮工具调用上限"
            description="一次对话累计调用工具次数达到上限后，强制智能体收尾输出，避免陷入死循环"
          >
            <Select
              value={values.maxCalls}
              options={[30, 50, 100, 300].map((value) => ({ value, label: `${value} 次` }))}
              onChange={(maxCalls) => onChange({ ...values, maxCalls })}
              menuClassName="w-[120px]"
            />
          </SettingRow>
        </SettingCard>
      </div>
      <SettingCard>
        <SettingRow title="网络搜索" description="智能体在调用 WebSearch 工具时使用的搜索源">
          <div className="flex items-center gap-2">
            <Select
              value={values.source}
              options={searchSources.map((s) => ({
                value: s.id,
                label: s.id === "bing" || values.configured.includes(s.id) ? s.name : `${s.name}（未配置 Key）`,
              }))}
              onChange={(source) => {
                if (source !== "bing" && !values.configured.includes(source)) setMessage("请先配置该搜索源的 API Key");
                else onChange({ ...values, source });
              }}
            />
            <button
              type="button"
              disabled={testing}
              onClick={() => void test()}
              className="cursor-pointer rounded-md bg-hover px-3 py-1 text-[12px] disabled:opacity-50"
            >
              {testing ? "测试中..." : "测试"}
            </button>
          </div>
        </SettingRow>
        <div className="space-y-2 px-5 py-3">
          {searchSources.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-subtle px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] leading-[18px]">
                  <span className="font-medium">{s.name}</span>
                  {s.url && (
                    <button
                      type="button"
                      title={s.url}
                      aria-label={`打开 ${s.name} 网站`}
                      className="cursor-pointer rounded p-0.5 text-muted hover:bg-hover"
                      onClick={() => onOpenUrl(s.url)}
                    >
                      ↗
                    </button>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] leading-[14px] text-muted">{s.description}</div>
              </div>
              {s.id !== "bing" && (
                <button
                  type="button"
                  onClick={() => setEditor(s.id)}
                  aria-label={`${values.configured.includes(s.id) ? "修改" : "配置"} ${s.name}`}
                  className={`cursor-pointer rounded-md px-3 py-1 text-[12px] font-medium
              ${values.configured.includes(s.id) ? "bg-hover" : "bg-primary text-white"}`}
                >
                  {values.configured.includes(s.id) ? "修改" : "配置"}
                </button>
              )}
            </div>
          ))}
        </div>
      </SettingCard>
      {message && (
        <p role="status" className="text-[12px] text-ink-secondary">
          {message}
        </p>
      )}
      {editor && (
        <SearchKeyEditor
          source={editor}
          configured={values.configured.includes(editor)}
          current={values.source === editor}
          onClose={() => setEditor("")}
          onOpenUrl={onOpenUrl}
          onSave={async (key) => {
            await onSaveKey(editor, key);
            onChange({
              ...values,
              configured: key
                ? [...new Set([...values.configured, editor])]
                : values.configured.filter((s) => s !== editor),
              source: !key && values.source === editor ? "bing" : values.source,
            });
            setEditor("");
            setMessage(key ? "已保存" : values.source === editor ? "已删除，已切回 Bing" : "已删除");
          }}
        />
      )}
    </SettingsTabLayout>
  );
}
function SearchKeyEditor({
  source,
  configured,
  current,
  onClose,
  onSave,
  onOpenUrl,
}: {
  source: string;
  configured: boolean;
  current: boolean;
  onClose: () => void;
  onSave: (key: string) => Promise<void>;
  onOpenUrl: (url: string) => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const provider = searchSources.find((s) => s.id === source);
  async function save(value: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Modal
        open={!deleting}
        onClose={() => {
          if (!busy) onClose();
        }}
        title={`${configured ? "修改" : "配置"} ${provider?.name} API Key`}
        width="w-[420px]"
        footer={
          <>
            {configured && (
              <ModalButton variant="danger" disabled={busy} onClick={() => setDeleting(true)}>
                删除 Key
              </ModalButton>
            )}
            <ModalButton onClick={onClose} disabled={busy}>
              取消
            </ModalButton>
            <ModalButton variant="primary" disabled={!key.trim() || busy} onClick={() => void save(key.trim())}>
              {busy ? "校验中..." : "保存"}
            </ModalButton>
          </>
        }
      >
        <div className="space-y-2">
          <p className="text-[12px] text-muted">
            可在{" "}
            <button
              type="button"
              className="cursor-pointer text-primary-text"
              onClick={() => onOpenUrl(provider?.url ?? "")}
            >
              {provider?.url}
            </button>{" "}
            申请
          </p>
          <input
            type="password"
            aria-label="API Key"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setError("");
            }}
            placeholder={configured ? "输入新 Key 以替换" : "API Key"}
            className="w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] outline-none
              focus:border-primary"
          />
          {error && (
            <p role="alert" className="text-[12px] text-danger">
              {error}
            </p>
          )}
        </div>
      </Modal>
      <Modal
        open={deleting}
        onClose={() => {
          if (!busy) setDeleting(false);
        }}
        title="删除 API Key"
        footer={
          <>
            <ModalButton disabled={busy} onClick={() => setDeleting(false)}>
              取消
            </ModalButton>
            <ModalButton variant="danger" disabled={busy} onClick={() => void save("")}>
              确认删除
            </ModalButton>
          </>
        }
      >
        <p className="text-[13px] text-ink-secondary">
          删除后将无法选择 {provider?.name}
          {current ? "，并自动切回 Bing" : ""}。确定要继续吗？
        </p>
      </Modal>
    </>
  );
}
