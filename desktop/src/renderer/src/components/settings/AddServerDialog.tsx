import { useEffect, useRef, useState } from "react";
import { normalizeServerAddress } from "../../../../shared/server-address";
import Modal, { ModalButton } from "../Modal";

export function AddServerDialog({
  servers,
  onClose,
  onSave,
  pending = false,
  saveError,
}: {
  servers: string[];
  onClose: () => void;
  onSave: (server: string) => void;
  pending?: boolean;
  saveError?: string;
}) {
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function save() {
    if (pending) return;
    let normalized: string;
    try {
      normalized = normalizeServerAddress(address);
    } catch (error) {
      setError((error as Error).message);
      return;
    }
    if (servers.includes(normalized)) {
      setError("该服务器地址已保存，请从列表中选择。");
      return;
    }
    onSave(normalized);
  }

  return (
    <Modal
      open
      title="添加服务器"
      width="w-[380px] max-w-[calc(100vw-32px)]"
      onClose={onClose}
      onConfirm={address.trim() && !pending ? save : undefined}
      footer={
        <>
          <ModalButton onClick={onClose}>取消</ModalButton>
          <ModalButton variant="primary" disabled={!address.trim() || pending} onClick={save}>
            {pending ? "保存中…" : "保存"}
          </ModalButton>
        </>
      }
    >
      <label className="block space-y-2 py-1 text-[13px] text-ink">
        <span>服务器地址</span>
        <input
          ref={inputRef}
          type="url"
          value={address}
          disabled={pending}
          spellCheck={false}
          onChange={(event) => {
            setAddress(event.target.value);
            setError("");
          }}
          placeholder="https://example.com"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-primary"
        />
      </label>
      {(error || saveError) && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {error || saveError}
        </p>
      )}
    </Modal>
  );
}
