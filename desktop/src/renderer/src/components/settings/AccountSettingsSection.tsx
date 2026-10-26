import { create, fromBinary } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import {
  AccountChangedSchema,
  AccountLoginRequestSchema,
  AccountLogoutRequestSchema,
  type AccountOperationResponse,
  type AccountSnapshot,
  AccountStatus,
  AddServerRequestSchema,
  CancelAccountLoginRequestSchema,
  CloudConnectionStatus,
  SelectServerRequestSchema,
  WriteClipboardTextRequestSchema,
} from "proto-desktop-ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Rpc, Subscription } from "xiaowei-gateway";
import type { Services } from "../../services";
import { AccountCard } from "./AccountCard";
import { AccountManagementDialog } from "./AccountManagementDialog";
import { AddServerDialog } from "./AddServerDialog";
import { PasswordLoginDialog } from "./PasswordLoginDialog";

export function AccountSettingsSection({ services }: { services: Services }) {
  const api = services.getAccount();
  const [snapshot, setSnapshot] = useState<AccountSnapshot>();
  const [dialog, setDialog] = useState<"login" | "add" | "manage">();
  const [loginServer, setLoginServer] = useState("");
  const returnToManagement = useRef(false);
  const loginOrigin = useRef<AccountSnapshot | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ text: string } | null>(null);
  const current = useRef<AccountSnapshot | undefined>(undefined);
  const active = useRef(false);
  const attempt = useRef<string | undefined>(undefined);
  const operationId = useRef(0);
  const operationRequest = useRef<Rpc<AccountOperationResponse> | undefined>(undefined);

  const accept = useCallback((next: AccountSnapshot) => {
    if (!active.current || (current.current && next.revision < current.current.revision)) return;
    current.current = next;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    active.current = true;
    let disposed = false;
    let subscription: Subscription | undefined;
    void (async () => {
      const handle = await services
        .getGateway()
        .subscribe(AccountChangedSchema.typeName, undefined, (bytes) => {
          const next = fromBinary(AccountChangedSchema, bytes).snapshot;
          if (!disposed && next) accept(next);
        });
      if (disposed) {
        handle.close();
        return;
      }
      subscription = handle;
      const next = await api.get(create(EmptySchema));
      if (!disposed) accept(next);
    })().catch(() => {
      if (!disposed) setError("加载账号设置失败");
    });
    return () => {
      disposed = true;
      active.current = false;
      operationId.current++;
      operationRequest.current?.cancel();
      subscription?.close();
      const id = attempt.current;
      attempt.current = undefined;
      if (id)
        void api
          .cancelLogin(create(CancelAccountLoginRequestSchema, { attemptId: id }))
          .catch(() => {});
    };
  }, [api, services, accept]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  function closeDialog() {
    operationId.current++;
    operationRequest.current?.cancel();
    operationRequest.current = undefined;
    const id = attempt.current;
    attempt.current = undefined;
    if (id)
      void api.cancelLogin(create(CancelAccountLoginRequestSchema, { attemptId: id })).catch(() => {
        if (active.current) setNotice({ text: "取消登录请求失败，请检查账号状态" });
      });
    setDialog(dialog === "login" && returnToManagement.current ? "manage" : undefined);
    setBusy(false);
    setError("");
  }

  async function run(
    work: () => Rpc<AccountOperationResponse>,
    options: { close?: boolean; minimumPendingMs?: number; showError?: boolean } = {},
  ) {
    const id = ++operationId.current;
    setBusy(true);
    setError("");
    setNotice(null);
    const minimumPending =
      (options.minimumPendingMs ?? 0) > 0
        ? new Promise<void>((resolve) => setTimeout(resolve, options.minimumPendingMs))
        : undefined;
    try {
      const request = work();
      operationRequest.current = request;
      const result = await request;
      await minimumPending;
      if (!active.current || operationId.current !== id) return;
      if (result.snapshot) accept(result.snapshot);
      if (result.code !== 0) {
        if (options.showError !== false) setError(result.msg || "账号操作失败");
      } else if (options.close) {
        setDialog(dialog === "login" && returnToManagement.current ? "manage" : undefined);
      }
      return result;
    } catch {
      await minimumPending;
      if (active.current && operationId.current === id && options.showError !== false) {
        setError("账号操作失败，请重试");
      }
    } finally {
      if (active.current && operationId.current === id) {
        attempt.current = undefined;
        operationRequest.current = undefined;
        setBusy(false);
      }
    }
  }

  if (!snapshot)
    return (
      <p role="status" className="px-5 py-2 text-[12px] text-muted">
        {error || "加载账号设置…"}
      </p>
    );

  const accountBusy =
    busy ||
    snapshot.status === AccountStatus.RESTORING ||
    snapshot.status === AccountStatus.SIGNING_IN;
  // 登录事件可能先于最短 loading 时间到达，卡片与浮层结束时一起切换。
  const cardSnapshot = dialog === "login" && busy ? (loginOrigin.current ?? snapshot) : snapshot;
  const cardUser = cardSnapshot.user;
  const statusMessage = (dialog ? "" : error) || cardSnapshot.statusMessage;

  return (
    <div>
      <AccountCard
        servers={snapshot.servers}
        server={cardSnapshot.selectedServer}
        user={cardUser ? { uid: cardUser.userId } : undefined}
        connectionStatus={
          cardSnapshot.cloudConnection === CloudConnectionStatus.CONNECTED
            ? "connected"
            : cardSnapshot.cloudConnection === CloudConnectionStatus.CONNECTING
              ? "connecting"
              : cardSnapshot.cloudConnection === CloudConnectionStatus.RECONNECTING
                ? "reconnecting"
                : "disconnected"
        }
        statusMessage={statusMessage}
        busy={accountBusy || dialog !== undefined}
        onSelectServer={(serverAddress) => {
          void run(() => api.selectServer(create(SelectServerRequestSchema, { serverAddress })));
        }}
        onAddServer={() => {
          setError("");
          setDialog("add");
        }}
        onLogin={() => {
          loginOrigin.current = snapshot;
          returnToManagement.current = false;
          setLoginServer(snapshot.selectedServer);
          setError("");
          setDialog("login");
        }}
        onManage={() => {
          setError("");
          setDialog("manage");
        }}
        onCopyUid={() => {
          void services
            .getSystem()
            .writeClipboardText(
              create(WriteClipboardTextRequestSchema, {
                text: snapshot.user?.userId ?? "",
              }),
            )
            .then(() => {
              if (active.current) setNotice({ text: "已复制 UID" });
            })
            .catch(() => {
              if (active.current) setNotice({ text: "复制 UID 失败" });
            });
        }}
      />
      {!cardUser && statusMessage && (
        <p role="alert" className="mt-2 px-1 text-[12px] text-danger">
          {statusMessage}
        </p>
      )}
      {notice &&
        createPortal(
          <div
            role="status"
            className="pointer-events-none fixed bottom-5 left-1/2 z-[250] max-w-[80%]
              -translate-x-1/2 rounded-lg bg-elevated px-4 py-2 text-[13px] text-ink shadow-lg"
          >
            {notice.text}
          </div>,
          document.body,
        )}
      {dialog === "manage" && (
        <AccountManagementDialog
          servers={snapshot.servers.map((address) => ({
            address,
            uid: snapshot.serverAccounts.find((entry) => entry.serverAddress === address)?.user
              ?.userId,
          }))}
          currentServer={snapshot.selectedServer}
          busy={accountBusy}
          error={error || snapshot.statusMessage}
          onClose={closeDialog}
          onSwitch={(serverAddress) => {
            void run(() => api.selectServer(create(SelectServerRequestSchema, { serverAddress })));
          }}
          onLogin={(address) => {
            loginOrigin.current = snapshot;
            returnToManagement.current = true;
            setLoginServer(address);
            setError("");
            setDialog("login");
          }}
          onLogout={(serverAddress) => {
            void run(() => api.logout(create(AccountLogoutRequestSchema, { serverAddress })));
          }}
          onLogoutAll={() => {
            void run(() => api.logout(create(AccountLogoutRequestSchema, { allServers: true })), {
              close: true,
            });
          }}
          onAddServer={async (serverAddress) => {
            const result = await run(
              () => api.addServer(create(AddServerRequestSchema, { serverAddress })),
              { showError: false },
            );
            if (result?.code !== 0) throw new Error(result?.msg || "添加服务器失败，请重试");
          }}
        />
      )}
      {dialog === "add" && (
        <AddServerDialog
          servers={snapshot.servers}
          pending={busy}
          saveError={error}
          onClose={closeDialog}
          onSave={(serverAddress) => {
            void run(() => api.addServer(create(AddServerRequestSchema, { serverAddress })), {
              close: true,
            });
          }}
        />
      )}
      {dialog === "login" && (
        <PasswordLoginDialog
          server={loginServer}
          pending={busy}
          error={error}
          onClose={closeDialog}
          onSubmit={(email, password) => {
            const attemptId = crypto.randomUUID();
            attempt.current = attemptId;
            void run(
              () =>
                api.login(
                  create(AccountLoginRequestSchema, {
                    serverAddress: loginServer,
                    password: { email, password },
                    attemptId,
                  }),
                ),
              { close: true, minimumPendingMs: 500 },
            );
          }}
        />
      )}
    </div>
  );
}
