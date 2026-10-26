import {
  AgentInteractionExpireReason,
  AgentInteractionStatus,
  type AgentInteraction as View,
} from "proto-desktop-ts";
import { AgentToolIcon } from "./AgentToolIcon";
import type { InteractionControls } from "./message-blocks";

export function AgentInteraction({
  view,
  controls,
}: {
  view: View;
  controls?: InteractionControls;
}) {
  const pending = view.status === AgentInteractionStatus.PENDING;
  const form = controls?.form(view.interactionId);
  const disabled = !controls || !pending || !!form?.submitting || !!form?.uncertain;
  const question = view.request.case === "question" ? view.request.value : undefined;
  const permission = view.request.case === "permission" ? view.request.value : undefined;
  const answer = view.answer?.answer;
  const selected =
    answer?.case === "question" ? answer.value.selectedIndices : (form?.selectedIndices ?? []);
  const text = answer?.case === "question" ? (answer.value.text ?? "") : (form?.text ?? "");
  const canSubmit = !disabled && (!!text.trim() || selected.length > 0);
  const resolved = view.status === AgentInteractionStatus.RESOLVED;
  const reply = [...selected.map((index) => question?.options[index] ?? ""), text.trim()]
    .filter(Boolean)
    .join("；");
  const summary = resolved
    ? answer?.case === "permission"
      ? answer.value.allow
        ? "已批准"
        : "已拒绝"
      : `已回复：${reply}`
    : view.status === AgentInteractionStatus.EXPIRED
      ? view.expireReason === AgentInteractionExpireReason.RECOVERY
        ? "重启后已失效"
        : "已失效"
      : question
        ? "等待你回复"
        : "等待授权";
  const content = (
    <div className="agent-interaction-content">
      {question && (
        <>
          <p className="whitespace-pre-wrap break-words">{question.question}</p>
          {question.options.length > 0 && (
            <fieldset className="agent-interaction-options" aria-label="回答选项">
              {question.options.map((option, index) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: Fixed option indices.
                  key={`${index}-${option}`}
                  type="button"
                  className="agent-interaction-option"
                  aria-pressed={selected.includes(index)}
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    const next = question.multiSelect
                      ? selected.includes(index)
                        ? selected.filter((value) => value !== index)
                        : [...selected, index].sort((a, b) => a - b)
                      : [index];
                    controls?.onSelectionChange(view.interactionId, next);
                    if (!question.multiSelect) controls?.onRespond(view.interactionId);
                  }}
                >
                  <span aria-hidden="true">
                    {question.multiSelect ? (selected.includes(index) ? "☑" : "☐") : index + 1}
                  </span>
                  <span className="min-w-0 break-words">{option}</span>
                </button>
              ))}
            </fieldset>
          )}
          {pending ? (
            <>
              <textarea
                aria-label="补充回答"
                placeholder={question.options.length ? "也可以直接填写回答" : "填写回答"}
                rows={2}
                value={text}
                disabled={disabled}
                onChange={(event) => controls?.onTextChange(view.interactionId, event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" ||
                    event.shiftKey ||
                    event.nativeEvent.isComposing ||
                    event.keyCode === 229
                  )
                    return;
                  event.preventDefault();
                  if (canSubmit) controls?.onRespond(view.interactionId);
                }}
              />
              <button
                type="button"
                className="agent-interaction-submit"
                disabled={!canSubmit}
                onClick={() => controls?.onRespond(view.interactionId)}
              >
                {form?.submitting ? "提交中…" : "提交回答"}
              </button>
            </>
          ) : (
            text && <p className="whitespace-pre-wrap break-words text-muted">{text}</p>
          )}
        </>
      )}
      {permission && (
        <>
          <p className="break-words">
            允许写入{permission.isDirectory ? "目录及子路径" : "文件"}：
            <span className="agent-permission-path">{permission.path}</span>
          </p>
          {permission.reason && (
            <p className="whitespace-pre-wrap break-words text-muted">{permission.reason}</p>
          )}
          {pending && (
            <>
              <p className="text-xs text-muted">批准后在本对话中持续有效。</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="agent-interaction-submit"
                  disabled={disabled}
                  onClick={() => controls?.onRespond(view.interactionId, true)}
                >
                  {form?.submitting ? "提交中…" : "批准"}
                </button>
                <button
                  type="button"
                  className="agent-interaction-option"
                  disabled={disabled}
                  onClick={() => controls?.onRespond(view.interactionId, false)}
                >
                  拒绝
                </button>
              </div>
            </>
          )}
        </>
      )}
      {pending && form?.error && (
        <p role="alert" className="text-xs text-danger">
          {form.error}
        </p>
      )}
      {pending && form?.uncertain && (
        <button
          type="button"
          className="agent-interaction-submit"
          disabled={form.submitting}
          onClick={() => controls?.onRespond(view.interactionId)}
        >
          重试提交
        </button>
      )}
    </div>
  );
  const title = (
    <>
      <AgentToolIcon kind={question ? "question" : "permission"} />
      <span className="shrink-0">{question ? "向你提问" : "请求写入权限"}</span>
      <span className="min-w-0 truncate text-xs text-muted" title={summary}>
        · {summary}
      </span>
    </>
  );

  return pending ? (
    <section className="agent-interaction" aria-label={question ? "待回答问题" : "待授权请求"}>
      <div className="agent-interaction-title">{title}</div>
      {content}
    </section>
  ) : (
    <details className="agent-interaction">
      <summary className="agent-interaction-title">
        {title}
        <span className="agent-disclosure" aria-hidden="true">
          ›
        </span>
      </summary>
      {content}
    </details>
  );
}
