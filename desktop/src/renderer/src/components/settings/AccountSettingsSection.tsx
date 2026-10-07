import { create, fromBinary } from "@bufbuild/protobuf";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccountChangedSchema,
  AccountLoginRequestSchema,
  type AccountOperationResponse,
  type AccountSnapshot,
  AccountStatus,
  AddServerRequestSchema,
  CancelAccountLoginRequestSchema,
  EmptySchema,
  SelectServerRequestSchema,
  WriteClipboardTextRequestSchema,
} from "xiaowei-contracts";
import type { Subscription } from "xiaowei-gateway";
import type { Services } from "../../services";
import { AccountCard } from "./AccountCard";
import { AddServerDialog } from "./AddServerDialog";
import { PasswordLoginDialog } from "./PasswordLoginDialog";

export function AccountSettingsSection({ services }: { services: Services }) {
  const api = services.getAccount();
  const [snapshot, setSnapshot] = useState<AccountSnapshot>();
  const [dialog, setDialog] = useState<"login" | "add">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = useRef<AccountSnapshot | undefined>(undefined);
  const active = useRef(false);
  const attempt = useRef<string | undefined>(undefined);
  const operationId = useRef(0);

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
      const handle = await services.getGateway().subscribe(AccountChangedSchema.typeName, undefined, (bytes) => {
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
      subscription?.close();
      const id = attempt.current;
      attempt.current = undefined;
      if (id) void api.cancelLogin(create(CancelAccountLoginRequestSchema, { attemptId: id })).catch(() => {});
    };
  }, [api, services, accept]);

  function closeDialog() {
    operationId.current++;
    const id = attempt.current;
    attempt.current = undefined;
    if (id)
      void api.cancelLogin(create(CancelAccountLoginRequestSchema, { attemptId: id })).catch(() => {
        if (active.current) setNotice("取消登录请求失败，请检查账号状态");
      });
    setDialog(undefined);
    setBusy(false);
    setError("");
  }

  async function run(work: () => Promise<AccountOperationResponse>, close = false, minimumPendingMs = 0) {
    const id = ++operationId.current;
    setBusy(true);
    setError("");
    setNotice("");
    const minimumPending =
      minimumPendingMs > 0 ? new Promise<void>((resolve) => setTimeout(resolve, minimumPendingMs)) : undefined;
    try {
      const result = await work();
      await minimumPending;
      if (!active.current || operationId.current !== id) return;
      if (result.snapshot) accept(result.snapshot);
      if (result.code !== 0) setError(result.msg || "账号操作失败");
      else if (close) setDialog(undefined);
    } catch {
      await minimumPending;
      if (active.current && operationId.current === id) setError("账号操作失败，请重试");
    } finally {
      if (active.current && operationId.current === id) {
        attempt.current = undefined;
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
    busy || snapshot.status === AccountStatus.RESTORING || snapshot.status === AccountStatus.SIGNING_IN;
  // 登录事件可能先于最短 loading 时间到达，卡片与浮层结束时一起切换。
  const cardUser = dialog === "login" && busy ? undefined : snapshot.user;

  return (
    <div>
      <AccountCard
        servers={snapshot.servers}
        server={snapshot.selectedServer}
        user={cardUser ? { uid: cardUser.userId } : undefined}
        busy={accountBusy || dialog !== undefined}
        onSelectServer={(serverAddress) => {
          void run(() => api.selectServer(create(SelectServerRequestSchema, { serverAddress })));
        }}
        onAddServer={() => {
          setError("");
          setDialog("add");
        }}
        onLogin={() => {
          setError("");
          setDialog("login");
        }}
        onLogout={() => {
          void run(() => api.logout(create(EmptySchema)));
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
              if (active.current) setNotice("已复制 UID");
            })
            .catch(() => {
              if (active.current) setNotice("复制 UID 失败");
            });
        }}
      />
      {(snapshot.statusMessage || (error && !dialog)) && (
        <p role="alert" className="mt-2 px-1 text-[12px] text-danger">
          {error || snapshot.statusMessage}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 px-1 text-[12px] text-muted">
          {notice}
        </p>
      )}
      {dialog === "add" && (
        <AddServerDialog
          servers={snapshot.servers}
          pending={busy}
          saveError={error}
          onClose={closeDialog}
          onSave={(serverAddress) => {
            void run(() => api.addServer(create(AddServerRequestSchema, { serverAddress })), true);
          }}
        />
      )}
      {dialog === "login" && (
        <PasswordLoginDialog
          server={snapshot.selectedServer}
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
                    serverAddress: snapshot.selectedServer,
                    password: { email, password },
                    attemptId,
                  }),
                ),
              true,
              500,
            );
          }}
        />
      )}
    </div>
  );
}
