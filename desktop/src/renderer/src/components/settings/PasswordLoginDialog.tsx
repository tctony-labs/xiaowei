import { useEffect, useRef, useState } from "react";
import Modal, { ModalButton } from "../Modal";

export function PasswordLoginDialog({
  server,
  pending = false,
  error,
  onClose,
  onSubmit,
}: {
  server: string;
  pending?: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (email: string, password: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const canSubmit = Boolean(email.trim() && password && !pending);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  function submit() {
    if (canSubmit) formRef.current?.requestSubmit();
  }

  return (
    <Modal
      open
      title="登录"
      width="w-[380px] max-w-[calc(100vw-32px)]"
      contentClassName="relative px-5 py-3"
      onClose={onClose}
      onConfirm={canSubmit ? submit : undefined}
      footer={
        <>
          <ModalButton onClick={onClose}>取消</ModalButton>
          <ModalButton variant="primary" disabled={!canSubmit} onClick={submit}>
            {pending ? "登录中…" : "登录"}
          </ModalButton>
        </>
      }
    >
      <p
        role={error ? "alert" : undefined}
        title={error || undefined}
        className="absolute -top-2 right-5 left-5 h-[22px] truncate text-center text-[12px] leading-[22px] text-danger"
      >
        {error}
      </p>
      <form
        ref={formRef}
        className="space-y-4 py-1 text-[13px] text-ink"
        aria-busy={pending}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) onSubmit(email.trim(), password);
        }}
      >
        <div className="text-[12px]">
          <p className="text-muted">服务器</p>
          <p className="mt-1 leading-[18px] [overflow-wrap:anywhere]">{server}</p>
        </div>
        <label className="block space-y-1.5">
          <span>邮箱</span>
          <input
            ref={emailRef}
            type="email"
            autoComplete="username"
            required
            value={email}
            disabled={pending}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="输入邮箱"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none
              focus:border-primary disabled:opacity-60"
          />
        </label>
        <label className="block space-y-1.5">
          <span>密码</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            disabled={pending}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="输入密码"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none
              focus:border-primary disabled:opacity-60"
          />
        </label>
      </form>
    </Modal>
  );
}
