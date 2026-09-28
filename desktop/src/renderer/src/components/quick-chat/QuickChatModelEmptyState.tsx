export function QuickChatModelEmptyState({ onOpenSettings, error }: { onOpenSettings: () => void; error?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 text-center text-muted">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
        <path
          d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M7 9h10M7 13h6" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <div>
        <p className="text-sm text-ink">暂无可用模型</p>
        <p className="mt-1.5 text-xs leading-5">
          请先在{" "}
          <button
            type="button"
            onClick={onOpenSettings}
            className="cursor-pointer rounded-sm text-primary-text underline-offset-4 hover:underline
              focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            设置 - 模型
          </button>{" "}
          中配置。
        </p>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
