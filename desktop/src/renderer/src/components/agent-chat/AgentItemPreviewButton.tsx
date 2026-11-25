import { useState } from "react";

export function AgentItemPreviewButton({ onLoad }: { onLoad: () => Promise<unknown> }) {
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function load() {
    setLoading(true);
    setFailed(false);
    try {
      await onLoad();
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="text-xs text-muted">
      <button type="button" className="agent-history-load" disabled={loading} onClick={load}>
        {loading ? "正在加载…" : failed ? "重试加载完整内容" : "加载完整内容"}
      </button>
      {failed && <span role="alert"> 加载失败</span>}
    </div>
  );
}
