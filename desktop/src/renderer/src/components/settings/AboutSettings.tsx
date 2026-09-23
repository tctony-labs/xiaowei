import logo from "../../../../../resources/logo-clear.png";
import SettingsTabLayout from "./SettingsTabLayout";
export function AboutSettings({
  version,
  development,
  onCheckUpdate,
  showCheckUpdate = true,
  copyright,
}: {
  version: string;
  development: boolean;
  onCheckUpdate?: () => void;
  showCheckUpdate?: boolean;
  copyright?: string;
}) {
  return (
    <SettingsTabLayout title="关于">
      <div className="flex flex-col items-center rounded-xl bg-surface py-8 shadow-sm">
        <img src={logo} alt="XiaoWei" className="h-20 w-20 rounded-2xl" />
        <h3 className="mt-3 text-[15px] font-semibold">小微助手</h3>
        {version && <p className="mt-1 text-[13px] text-muted">版本 {version}</p>}
        <div className="mt-3 flex gap-4">
          {showCheckUpdate && !development && (
            <button
              type="button"
              onClick={onCheckUpdate}
              className="cursor-pointer text-[13px] text-primary-text hover:underline"
            >
              检查更新
            </button>
          )}
        </div>
      </div>
      {copyright && <p className="text-center text-[11px] text-muted">{copyright}</p>}
    </SettingsTabLayout>
  );
}
