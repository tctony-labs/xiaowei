interface SettingRowProps {
  /** 设置项标题 */
  title: string;
  /** 设置项描述 */
  description?: string;
  /** 右侧控件 */
  children: React.ReactNode;
}

/** 单行设置项：左侧 label + description，右侧 control */
export default function SettingRow({ title, description, children }: SettingRowProps) {
  return (
    <div className="flex min-h-[42px] items-center justify-between px-5 py-2.5">
      <div className="mr-4 min-w-0 flex-1">
        <div className="text-[13px] leading-[18px] text-ink">{title}</div>
        {description && <div className="mt-0.5 text-[11px] leading-[14px] text-muted">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
