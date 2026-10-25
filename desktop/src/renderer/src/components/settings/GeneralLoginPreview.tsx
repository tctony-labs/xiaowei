// Storybook and component test fixture. Account actions never contact a server.
import { useEffect, useState } from "react";
import { AccountCard, type AccountCardProps } from "./AccountCard";
import { AccountManagementDialog } from "./AccountManagementDialog";
import { AddServerDialog } from "./AddServerDialog";
import { PasswordLoginDialog } from "./PasswordLoginDialog";
import { SettingsPreview } from "./SettingsPreview";

export interface GeneralLoginPreviewProps {
  signedIn?: boolean;
  emptyServers?: boolean;
  longAddress?: boolean;
  initialDialog?: "login" | "add" | "manage";
  multipleSessions?: boolean;
  loginState?: "idle" | "pending" | "error";
  addState?: "idle" | "pending" | "error";
  connectionStatus?: AccountCardProps["connectionStatus"];
}

export function GeneralLoginPreview({
  signedIn = false,
  emptyServers = false,
  longAddress = false,
  initialDialog,
  multipleSessions = false,
  loginState = "idle",
  addState = "idle",
  connectionStatus = "connected",
}: GeneralLoginPreviewProps) {
  const initialServer = longAddress
    ? "https://development.example.test/xiaowei/very-long-reverse-proxy-path/another-path-segment"
    : "http://127.0.0.1:10001";
  const [servers, setServers] = useState(
    emptyServers ? [] : [initialServer, "https://team.example.test/xiaowei"],
  );
  const [server, setServer] = useState(emptyServers ? "" : initialServer);
  const [sessions, setSessions] = useState<Record<string, string>>(
    signedIn
      ? {
          [initialServer]: "u_7mK2qR9xW4nT8bYpC6dHfA",
          ...(multipleSessions
            ? { "https://team.example.test/xiaowei": "u_remote_8bYpC6dHfA" }
            : {}),
        }
      : {},
  );
  const [dialog, setDialog] = useState(initialDialog);
  const [loginServer, setLoginServer] = useState(initialServer);
  const [returnToManagement, setReturnToManagement] = useState(initialDialog === "manage");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(loginState === "error" ? "邮箱或密码错误" : "");
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!pending || loginState === "pending") return;
    const timer = setTimeout(() => {
      setPending(false);
      if (loginState === "error") {
        setError("邮箱或密码错误");
      } else {
        setSessions((current) => ({ ...current, [loginServer]: "u_7mK2qR9xW4nT8bYpC6dHfA" }));
        setServer(loginServer);
        setDialog(returnToManagement ? "manage" : undefined);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [pending, loginState, loginServer, returnToManagement]);

  function closeDialog() {
    setPending(false);
    setDialog(returnToManagement ? "manage" : undefined);
    setError("");
  }

  function logout(address: string) {
    setSessions((current) => {
      const next = { ...current };
      delete next[address];
      return next;
    });
    setCopied(false);
  }

  async function addServer(address: string) {
    // Simulate validation without contacting a real server.
    if (addState === "pending") await new Promise<void>(() => {});
    if (addState === "error") throw new Error("无法连接服务器，请检查地址后重试");
    setServers((current) => [...current, address]);
  }

  return (
    <>
      <SettingsPreview
        initialTab="general"
        accountSection={
          <AccountCard
            servers={servers}
            server={server}
            user={sessions[server] ? { uid: sessions[server] } : undefined}
            connectionStatus={connectionStatus}
            busy={dialog !== undefined}
            onSelectServer={setServer}
            onAddServer={() => {
              setReturnToManagement(false);
              setDialog("add");
            }}
            onLogin={() => {
              setLoginServer(server);
              setReturnToManagement(false);
              setCopied(false);
              setError("");
              setDialog("login");
            }}
            onManage={() => {
              setReturnToManagement(true);
              setDialog("manage");
            }}
            onCopyUid={() => setCopied(true)}
          />
        }
      />
      {dialog === "manage" && (
        <AccountManagementDialog
          servers={servers.map((address) => ({ address, uid: sessions[address] }))}
          currentServer={server}
          onClose={() => setDialog(undefined)}
          onSwitch={setServer}
          onLogin={(address) => {
            setLoginServer(address);
            setError("");
            setDialog("login");
          }}
          onLogout={logout}
          onLogoutAll={() => {
            setSessions({});
            setCopied(false);
            setDialog(undefined);
          }}
          onAddServer={addServer}
        />
      )}
      {dialog === "add" && (
        <AddServerDialog
          servers={servers}
          pending={adding}
          saveError={error}
          onClose={closeDialog}
          onSave={(address) => {
            setAdding(true);
            setError("");
            void addServer(address)
              .then(() => setDialog(undefined))
              .catch((error: Error) => setError(error.message))
              .finally(() => setAdding(false));
          }}
        />
      )}
      {dialog === "login" && (
        <PasswordLoginDialog
          server={loginServer}
          pending={pending}
          error={error}
          onClose={closeDialog}
          onSubmit={() => {
            setError("");
            setPending(true);
          }}
        />
      )}
      {copied && (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 z-[250] -translate-x-1/2 rounded-lg bg-elevated px-4 py-2
            text-[13px] text-ink shadow-lg"
        >
          已复制 UID（预览）
        </div>
      )}
    </>
  );
}
