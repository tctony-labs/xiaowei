// Storybook fixture only. Account actions are simulated and never contact a server.
import { useEffect, useState } from "react";
import { AccountCard, type AccountCardProps } from "./AccountCard";
import { AddServerDialog } from "./AddServerDialog";
import { PasswordLoginDialog } from "./PasswordLoginDialog";
import { SettingsPreview } from "./SettingsPreview";

export interface GeneralLoginPreviewProps {
  signedIn?: boolean;
  emptyServers?: boolean;
  longAddress?: boolean;
  initialDialog?: "login" | "add";
  loginState?: "idle" | "pending" | "error";
}

export function GeneralLoginPreview({
  signedIn = false,
  emptyServers = false,
  longAddress = false,
  initialDialog,
  loginState = "idle",
}: GeneralLoginPreviewProps) {
  const initialServer = longAddress
    ? "https://development.example.test/xiaowei/very-long-reverse-proxy-path/another-path-segment"
    : "http://127.0.0.1:10001";
  const [servers, setServers] = useState(emptyServers ? [] : [initialServer, "https://team.example.test/xiaowei"]);
  const [server, setServer] = useState(emptyServers ? "" : initialServer);
  const [user, setUser] = useState<AccountCardProps["user"]>(
    signedIn ? { uid: "u_7mK2qR9xW4nT8bYpC6dHfA" } : undefined,
  );
  const [dialog, setDialog] = useState(initialDialog);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(loginState === "error" ? "邮箱或密码错误" : "");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!pending || loginState === "pending") return;
    const timer = setTimeout(() => {
      setPending(false);
      if (loginState === "error") {
        setError("邮箱或密码错误");
      } else {
        setUser({ uid: "u_7mK2qR9xW4nT8bYpC6dHfA" });
        setDialog(undefined);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [pending, loginState]);

  function closeDialog() {
    setPending(false);
    setDialog(undefined);
    setError("");
  }

  return (
    <>
      <SettingsPreview
        initialTab="general"
        accountSection={
          <AccountCard
            servers={servers}
            server={server}
            user={user}
            busy={dialog !== undefined}
            onSelectServer={setServer}
            onAddServer={() => setDialog("add")}
            onLogin={() => {
              setCopied(false);
              setError("");
              setDialog("login");
            }}
            onLogout={() => {
              setUser(undefined);
              setCopied(false);
            }}
            onCopyUid={() => setCopied(true)}
          />
        }
      />
      {dialog === "add" && (
        <AddServerDialog
          servers={servers}
          onClose={closeDialog}
          onSave={(address) => {
            setServers((current) => [...current, address]);
            setServer(address);
            closeDialog();
          }}
        />
      )}
      {dialog === "login" && (
        <PasswordLoginDialog
          server={server}
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
