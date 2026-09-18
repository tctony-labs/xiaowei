interface SettingCardProps {
  title?: string;
  children: React.ReactNode;
}

/** 设置卡片容器 — 白色圆角卡片 */
export default function SettingCard({ title, children }: SettingCardProps) {
  return (
    <div>
      {title && (
        <div className="mb-2 px-1">
          <h3 className="text-xs font-medium text-muted">{title}</h3>
        </div>
      )}
      <div className="rounded-xl bg-surface shadow-sm">
        <div className="divide-y divide-subtle">{children}</div>
      </div>
    </div>
  );
}
