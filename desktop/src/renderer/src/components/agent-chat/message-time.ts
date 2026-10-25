// Matches xiaowei-next chat's formatRelativeTime, including its 30-day months.
export function formatMessageTime(timestampMs: bigint, now = Date.now()): string | undefined {
  const timestamp = Number(timestampMs);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return undefined;

  const diff = now - timestamp;
  if (diff < 60_000) return "刚刚";

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;

  return `${Math.floor(months / 12)} 年前`;
}
