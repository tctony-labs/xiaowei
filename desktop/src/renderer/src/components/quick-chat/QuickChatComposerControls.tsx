import Select from "../settings/Select";

const reasoningLabels: Record<string, string> = {
  off: "关闭思考",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "更高",
  max: "最高",
};

export interface ComposerControlsProps {
  modelOptions?: { value: string; label: string }[];
  selectedModelRef?: string;
  modelLabel?: string;
  reasoning?: string;
  supportedReasoning?: string[];
  configSaving?: boolean;
  onModelChange?: (value: string) => void;
  onReasoningChange?: (value: string) => void;
}

export function QuickChatComposerControls(props: ComposerControlsProps) {
  const reasoningOptions = (props.supportedReasoning ?? []).map((value) => ({
    value,
    label: reasoningLabels[value] ?? value,
  }));
  if (props.reasoning && !reasoningOptions.some((option) => option.value === props.reasoning)) {
    reasoningOptions.push({ value: props.reasoning, label: reasoningLabels[props.reasoning] ?? props.reasoning });
  }
  return (
    <div className="flex min-w-0 shrink-0 items-center justify-end gap-1 px-4 py-1 text-xs text-muted">
      <Select
        ariaLabel="对话模型"
        value={props.selectedModelRef ?? ""}
        options={props.modelOptions ?? []}
        placeholder={props.modelLabel || "选择模型"}
        disabled={props.configSaving || !props.modelOptions?.length}
        onChange={(value) => props.onModelChange?.(value)}
        className="min-w-0 max-w-[65%]"
        buttonClassName="quick-chat-config-chip max-w-full [&>span]:truncate"
        showChevron={false}
        menuClassName="quick-chat-config-menu max-w-[calc(100vw-32px)]"
        menuPortal
        menuPlacement="top"
      />
      <Select
        ariaLabel="思考强度"
        value={props.reasoning ?? ""}
        options={reasoningOptions}
        placeholder="默认"
        disabled={props.configSaving || props.supportedReasoning === undefined || reasoningOptions.length === 0}
        onChange={(value) => props.onReasoningChange?.(value)}
        buttonClassName="quick-chat-config-chip"
        menuClassName="quick-chat-config-menu"
        showChevron={false}
        leadingIcon={
          <svg className="size-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9.75 3.5a3 3 0 0 0-2.83 4 2.5 2.5 0 0 0-1.92 3.46 2.5 2.5 0 0 0 .92 4.04A2.5 2.5
                0 0 0 9 18.5a2.5 2.5 0 0 0 3 1.5V4.91a3 3 0 0 0-2.25-1.41Zm4.5 0A3 3 0 0 1 17.08
                7.5a2.5 2.5 0 0 1 1.92 3.46 2.5 2.5 0 0 1-.92 4.04A2.5 2.5 0 0 1 15 18.5a2.5 2.5
                0 0 1-3 1.5V4.91a3 3 0 0 1 2.25-1.41Z"
            />
          </svg>
        }
        menuPortal
        menuPlacement="top"
      />
      {props.configSaving && <span role="status">保存中…</span>}
    </div>
  );
}
