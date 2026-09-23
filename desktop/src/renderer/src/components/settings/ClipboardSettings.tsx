import Select from "./Select";
import SettingCard from "./SettingCard";
import SettingRow from "./SettingRow";
import SettingsTabLayout from "./SettingsTabLayout";
import Toggle from "./Toggle";
export interface ClipboardValues {
  enabled: boolean;
  autoPaste: boolean;
  retention: number;
}
export type CleanupStatus = "idle" | "cleaning" | "done" | "error";
export function ClipboardSettings({
  values,
  onChange,
  localModelEnabled,
  onOpenModels,
  storageBytes,
  refreshing,
  onRefresh,
  cleanup,
  onCleanup,
}: {
  values: ClipboardValues;
  onChange: (values: ClipboardValues) => void;
  localModelEnabled: boolean;
  onOpenModels: () => void;
  storageBytes: number;
  refreshing: boolean;
  onRefresh: () => void;
  cleanup: CleanupStatus;
  onCleanup: () => void;
}) {
  const units = ["B", "KB", "MB", "GB"];
  let size = storageBytes;
  let unit = 0;
  while (size >= 1024 && unit < 3) {
    size /= 1024;
    unit++;
  }
  return (
    <SettingsTabLayout title="剪贴板">
      <SettingCard>
        <SettingRow title="启用剪贴板记录" description="记录系统剪贴板的内容变化">
          <Toggle
            ariaLabel="启用剪贴板记录"
            checked={values.enabled}
            onChange={() => onChange({ ...values, enabled: !values.enabled })}
          />
        </SettingRow>
        <SettingRow title="自动粘贴" description="选择剪贴板结果时自动粘贴到当前应用">
          <Toggle
            ariaLabel="自动粘贴"
            checked={values.autoPaste}
            onChange={() => onChange({ ...values, autoPaste: !values.autoPaste })}
          />
        </SettingRow>
        <SettingRow title="图片内容提取" description="使用本地模型提取图片上的文字、理解图片内容">
          {localModelEnabled ? (
            <span className="text-[13px] text-ink-secondary">已启用</span>
          ) : (
            <button
              type="button"
              onClick={onOpenModels}
              className="cursor-pointer text-[13px] font-medium text-primary-text hover:underline"
            >
              去启用
            </button>
          )}
        </SettingRow>
        <SettingRow title="数据保留期限" description="超过期限的剪贴板记录将被自动删除">
          <Select
            value={values.retention}
            onChange={(retention) => onChange({ ...values, retention })}
            options={[1, 7, 15, 30, -1].map((value) => ({ value, label: value === -1 ? "永久" : `${value} 天` }))}
            menuClassName="w-[100px]"
          />
        </SettingRow>
        <SettingRow title="已用存储空间">
          <div className="flex items-center gap-2 text-[13px] text-ink-secondary">
            <span>{refreshing ? "计算中..." : `${size.toFixed(2)} ${units[unit]}`}</span>
            <button
              type="button"
              aria-label="刷新存储空间"
              disabled={refreshing}
              onClick={onRefresh}
              className="cursor-pointer rounded-md p-1 text-muted hover:bg-hover disabled:opacity-50"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                className={refreshing ? "animate-spin" : ""}
              >
                <path
                  d="M13.65 2.35 v3.15 H10.5 M2.35 8 a5.65 5.65 0 0 1 9.6-4.01 l1.7 1.51 M2.35 13.65 V10.5 H5.5
              M13.65 8 a5.65 5.65 0 0 1-9.6 4.01 L2.35 10.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </SettingRow>
        <SettingRow title="清理全部" description="清理当前所有未收藏、无备注、无标签的记录">
          <div className="flex items-center gap-2">
            {cleanup === "done" && (
              <span role="status" className="text-[11px] text-muted">
                清理完成
              </span>
            )}
            {cleanup === "error" && (
              <span role="alert" className="text-[11px] text-danger">
                清理失败，请重试
              </span>
            )}
            <button
              type="button"
              disabled={cleanup === "cleaning"}
              onClick={onCleanup}
              className="cursor-pointer rounded-lg bg-hover px-3 py-1.5 text-[13px] disabled:opacity-50"
            >
              {cleanup === "cleaning" ? "清理中..." : "清理"}
            </button>
          </div>
        </SettingRow>
      </SettingCard>
    </SettingsTabLayout>
  );
}
