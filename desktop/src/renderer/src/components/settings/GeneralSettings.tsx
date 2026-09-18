import SegmentedControl from "./SegmentedControl";
import SettingCard from "./SettingCard";
import SettingRow from "./SettingRow";
import SettingsTabLayout from "./SettingsTabLayout";
import Toggle from "./Toggle";

export interface GeneralValues {
  theme: "system" | "light" | "dark";
  autostart: boolean;
  bookmarks: boolean;
}
export interface AccountView {
  loggedIn: boolean;
  loggingIn?: boolean;
  nickname: string;
  uin: string;
  avatar?: string;
  status: "disconnected" | "connecting" | "connected" | "credential_rejected";
  error?: string;
}
const statuses = {
  disconnected: ["未连接", "bg-muted"],
  connecting: ["连接中", "bg-amber-500"],
  connected: ["已连接", "bg-primary"],
  credential_rejected: ["登录已失效", "bg-danger"],
};
export function GeneralSettings({
  values,
  account,
  onChange,
  onLogin,
  onLogout,
  onCopy,
}: {
  values: GeneralValues;
  account: AccountView;
  onChange: (values: GeneralValues) => void;
  onLogin: () => void;
  onLogout: () => void;
  onCopy: () => void;
}) {
  return (
    <SettingsTabLayout title="通用">
      <SettingCard>
        {account.loggedIn ? (
          <div className="flex min-h-[42px] items-center justify-between px-5 py-2.5">
            <div className="mr-4 flex min-w-0 flex-1 items-center gap-2.5">
              {account.avatar && <img src={account.avatar} alt="" className="size-7 rounded-full object-cover" />}
              <div className="min-w-0">
                <div className="truncate text-[13px] leading-[18px]">{account.nickname || "微信用户"}</div>
                <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                  {account.uin}
                  <button
                    type="button"
                    aria-label="复制 UIN"
                    onClick={onCopy}
                    className="cursor-pointer rounded p-0.5 hover:bg-hover"
                  >
                    ⧉
                  </button>
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="flex items-center gap-2 text-[12px] text-ink-secondary">
                <span className={`size-2 rounded-full ${statuses[account.status][1]}`} />
                {statuses[account.status][0]}
              </span>
              <button
                type="button"
                onClick={onLogout}
                className="cursor-pointer rounded-md bg-danger/10 px-3 py-1 text-[12px] font-medium text-danger"
              >
                退出登录
              </button>
            </div>
          </div>
        ) : (
          <SettingRow title="未登录">
            <button
              type="button"
              disabled={account.loggingIn}
              onClick={onLogin}
              className="cursor-pointer rounded-md bg-primary px-3 py-1 text-[12px] font-medium text-white
              disabled:opacity-60"
            >
              {account.loggingIn ? "等待扫码…" : "登录"}
            </button>
          </SettingRow>
        )}
        {account.error && (
          <p role="alert" className="px-5 pb-2 text-[11px] text-danger">
            {account.error}
          </p>
        )}
      </SettingCard>
      <SettingCard>
        <SettingRow title="主题">
          <SegmentedControl
            value={values.theme}
            options={[
              { value: "system", label: "跟随系统" },
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
            onChange={(theme) => onChange({ ...values, theme })}
          />
        </SettingRow>
        <SettingRow title="开机自启动">
          <Toggle
            ariaLabel="开机自启动"
            checked={values.autostart}
            onChange={() => onChange({ ...values, autostart: !values.autostart })}
          />
        </SettingRow>
      </SettingCard>
      <SettingCard>
        <SettingRow title="全局搜索包含浏览器书签">
          <Toggle
            ariaLabel="全局搜索包含浏览器书签"
            checked={values.bookmarks}
            onChange={() => onChange({ ...values, bookmarks: !values.bookmarks })}
          />
        </SettingRow>
      </SettingCard>
    </SettingsTabLayout>
  );
}
