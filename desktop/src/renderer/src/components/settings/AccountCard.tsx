import { useRef } from "react";
import Select from "./Select";
import SettingCard from "./SettingCard";

export interface AccountCardProps {
  servers: string[];
  server: string;
  user?: { uid: string; avatar?: string };
  busy?: boolean;
  onSelectServer: (server: string) => void;
  onAddServer: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onCopyUid: () => void;
}

export function AccountCard({
  servers,
  server,
  user,
  busy = false,
  onSelectServer,
  onAddServer,
  onLogin,
  onLogout,
  onCopyUid,
}: AccountCardProps) {
  const serverAnchorRef = useRef<HTMLDivElement>(null);

  return (
    <SettingCard>
      <div className="flex h-[58px] items-center justify-between gap-4 px-5 py-2.5">
        {user ? (
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {user.avatar ? (
              <img src={user.avatar} alt="用户头像" className="size-7 shrink-0 rounded-full object-cover" />
            ) : (
              <span
                role="img"
                aria-label="默认头像"
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-hover text-muted"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <circle cx="9" cy="6" r="3" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M3 16a6 6 0 0 1 12 0" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              </span>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-[13px] leading-[18px]">
                <span className="truncate" title={`UID：${user.uid}`}>
                  UID：{user.uid}
                </span>
                <button
                  type="button"
                  aria-label="复制 UID"
                  onClick={onCopyUid}
                  className="shrink-0 cursor-pointer rounded p-0.5 text-muted hover:bg-hover"
                >
                  ⧉
                </button>
              </div>
              <p className="mt-0.5 truncate text-[11px] leading-[14px] text-muted" title={server}>
                {server}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div ref={serverAnchorRef} className="w-[260px] min-w-0">
              <Select
                ariaLabel="登录服务器"
                value={server}
                placeholder={servers.length === 0 ? "添加服务器" : "选择服务器"}
                disabled={busy}
                options={[
                  ...servers.map((address) => ({ value: address, label: address })),
                  { value: "add-server", label: "+ 添加服务器" },
                ]}
                onChange={(value) => {
                  if (value === "add-server") onAddServer();
                  else onSelectServer(value);
                }}
                className="w-full"
                buttonClassName="w-full justify-between [&>span]:truncate [&>svg]:shrink-0"
                menuClassName="[&>button]:block [&>button]:truncate [&>button]:text-left"
                menuPortal
                menuAnchorRef={serverAnchorRef}
              />
            </div>
          </div>
        )}
        <button
          type="button"
          disabled={busy || (!user && !server)}
          onClick={user ? onLogout : onLogin}
          className={`shrink-0 cursor-pointer rounded-md px-3 py-1 text-[12px] font-medium
            disabled:cursor-not-allowed disabled:opacity-60 ${
              user ? "bg-danger/10 text-danger" : "bg-primary text-white"
            }`}
        >
          {user ? "退出登录" : "登录"}
        </button>
      </div>
    </SettingCard>
  );
}
