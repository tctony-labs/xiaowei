import type { ReactNode } from "react";

interface SettingsTabLayoutProps {
  title: string;
  description?: string;
  leading?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  titleClassName?: string;
}

/** 设置 Tab 通用布局：标题栏固定，只有下方内容区域滚动。 */
export default function SettingsTabLayout({
  title,
  description,
  leading,
  actions,
  children,
  contentClassName = "space-y-5 overflow-y-auto px-6 pb-6 pt-0.5",
  titleClassName = "text-base",
}: SettingsTabLayoutProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-4 settings-layout px-6 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {leading ? <div className="relative z-20 shrink-0">{leading}</div> : null}
          <div className="min-w-0">
            <h2 className={`${titleClassName} truncate font-semibold text-ink`}>{title}</h2>
            {description ? <p className="mt-1 truncate text-sm text-ink-secondary">{description}</p> : null}
          </div>
        </div>
        {actions ? <div className="relative z-20 shrink-0">{actions}</div> : null}
      </header>
      <div className={`min-h-0 flex-1 ${contentClassName}`}>{children}</div>
    </div>
  );
}
