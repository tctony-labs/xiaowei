import { useEffect, useRef, useState } from "react";
import { normalizeServerAddress } from "../../../../shared/server-address";
import Modal, { ModalButton } from "../Modal";

export interface ManagedServer {
  address: string;
  uid?: string;
}

export function AccountManagementDialog({
  servers,
  currentServer,
  onClose,
  onSwitch,
  onLogin,
  onLogout,
  onLogoutAll,
  onAddServer,
  busy = false,
  error,
}: {
  servers: ManagedServer[];
  currentServer: string;
  onClose: () => void;
  onSwitch: (server: string) => void;
  onLogin: (server: string) => void;
  onLogout: (server: string) => void;
  onLogoutAll: () => void;
  onAddServer: (server: string) => void | Promise<void>;
  busy?: boolean;
  error?: string;
}) {
  const hasSessions = servers.some((server) => server.uid);
  const listRef = useRef<HTMLUListElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [addError, setAddError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (adding) {
      addressRef.current?.scrollIntoView?.({ block: "nearest" });
      addressRef.current?.focus();
    }
  }, [adding]);

  useEffect(() => {
    const dialog = listRef.current?.closest('[role="dialog"]');
    if (!dialog) return;
    const previousFocus = document.activeElement;
    dialog.querySelector<HTMLButtonElement>("button")?.focus();

    function keepFocus(event: Event) {
      const keyEvent = event as KeyboardEvent;
      if (keyEvent.key !== "Tab") return;
      const controls = dialog?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])",
      );
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (keyEvent.shiftKey && document.activeElement === first) {
        keyEvent.preventDefault();
        last.focus();
      } else if (!keyEvent.shiftKey && document.activeElement === last) {
        keyEvent.preventDefault();
        first.focus();
      }
    }

    dialog.addEventListener("keydown", keepFocus);
    return () => {
      dialog.removeEventListener("keydown", keepFocus);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  async function addServer() {
    if (busy || saving) return;
    let normalized: string;
    try {
      normalized = normalizeServerAddress(address);
    } catch (error) {
      setAddError((error as Error).message);
      return;
    }
    if (servers.some((server) => server.address === normalized)) {
      setAddError("该服务器地址已保存，请从列表中选择。");
      return;
    }

    setSaving(true);
    setAddError("");
    try {
      await onAddServer(normalized);
      setAdding(false);
      setAddress("");
    } catch (error) {
      setAddError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      title="账号管理"
      width="w-[500px] max-w-[calc(100vw-32px)]"
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <ModalButton disabled={adding || busy} onClick={() => setAdding(true)}>
            + 添加新服务器
          </ModalButton>
          {hasSessions && (
            <button
              type="button"
              disabled={busy || saving}
              onClick={onLogoutAll}
              className="cursor-pointer rounded px-2 py-1 text-[12px] text-danger
                enabled:hover:bg-danger/10 focus-visible:bg-danger/10 disabled:opacity-50"
            >
              退出全部
            </button>
          )}
        </div>
      }
    >
      {error && (
        <p role="alert" className="mb-3 text-[12px] text-danger">
          {error}
        </p>
      )}
      <ul ref={listRef} className="max-h-[300px] overflow-y-auto rounded-lg border border-line">
        {servers.map(({ address, uid }) => (
          <li
            key={address}
            aria-label={address}
            aria-current={address === currentServer ? "true" : undefined}
            className={`relative flex items-center gap-3 border-b border-line px-3 py-3
              last:border-b-0 ${
                address === currentServer
                  ? `bg-primary/5 before:pointer-events-none before:absolute before:inset-y-0
                  before:left-0 before:w-[3px] before:bg-primary`
                  : ""
              }`}
          >
            <div className="min-w-0 flex-1">
              <p
                className={`truncate text-[13px] text-ink ${
                  address === currentServer ? "font-medium" : ""
                }`}
                title={address}
              >
                {address}
              </p>
              <p className="mt-1 truncate text-[11px] text-muted" title={uid}>
                {uid || "未登录"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-[12px]">
              {address === currentServer ? (
                <span className="rounded bg-primary/10 px-2 py-1 text-primary-text">当前</span>
              ) : uid ? (
                <button
                  type="button"
                  disabled={busy || saving}
                  onClick={() => onSwitch(address)}
                  className="cursor-pointer rounded px-2 py-1 text-ink
                    hover:bg-hover focus-visible:bg-hover disabled:opacity-50"
                >
                  切换
                </button>
              ) : null}
              {uid ? (
                <button
                  type="button"
                  disabled={address === currentServer || busy || saving}
                  onClick={() => onLogout(address)}
                  className="cursor-pointer rounded px-2 py-1 text-danger
                    enabled:hover:bg-danger/10 focus-visible:bg-danger/10
                    disabled:cursor-not-allowed disabled:text-muted"
                >
                  退出
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy || saving}
                  onClick={() => onLogin(address)}
                  className="cursor-pointer rounded bg-hover px-2 py-1 text-ink
                    focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50"
                >
                  登录
                </button>
              )}
            </div>
          </li>
        ))}
        {adding && (
          <li aria-label="添加新服务器" className="px-3 py-3">
            <form
              aria-busy={saving}
              onSubmit={(event) => {
                event.preventDefault();
                if (address.trim()) void addServer();
              }}
            >
              <div className="flex items-center gap-2">
                <input
                  ref={addressRef}
                  aria-label="服务器地址"
                  aria-invalid={Boolean(addError)}
                  aria-describedby={addError ? "add-server-error" : undefined}
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  value={address}
                  disabled={busy || saving}
                  spellCheck={false}
                  onChange={(event) => {
                    setAddress(event.target.value);
                    setAddError("");
                  }}
                  placeholder="https://example.com"
                  className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1.5
                    text-[12px] text-ink focus:border-primary disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={!address.trim() || busy || saving}
                  className="shrink-0 cursor-pointer rounded bg-primary px-2 py-1 text-[12px]
                    text-white focus-visible:ring-1 focus-visible:ring-primary
                    disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="size-3 animate-spin rounded-full border border-current
                          border-t-transparent"
                      />
                      校验中…
                    </span>
                  ) : (
                    "添加"
                  )}
                </button>
                <button
                  type="button"
                  disabled={busy || saving}
                  onClick={() => {
                    setAdding(false);
                    setAddress("");
                    setAddError("");
                  }}
                  className="shrink-0 cursor-pointer rounded px-2 py-1 text-[12px] text-muted
                    hover:bg-hover focus-visible:bg-hover disabled:cursor-not-allowed"
                >
                  取消
                </button>
              </div>
              {addError && (
                <p id="add-server-error" role="alert" className="mt-2 text-[12px] text-danger">
                  {addError}
                </p>
              )}
            </form>
          </li>
        )}
      </ul>
    </Modal>
  );
}
