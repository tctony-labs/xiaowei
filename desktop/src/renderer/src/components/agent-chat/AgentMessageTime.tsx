import { useEffect, useState } from "react";
import { formatMessageTime } from "./message-time";

export function AgentMessageTime({ timestampMs }: { timestampMs?: bigint }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!timestampMs) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [timestampMs]);

  const label = timestampMs === undefined ? undefined : formatMessageTime(timestampMs, now);
  return label ? <time>{label}</time> : null;
}
