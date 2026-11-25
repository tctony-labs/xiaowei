import { create } from "@bufbuild/protobuf";
import {
  type CustomEditor,
  CustomEditorSchema,
  type EditorPreference,
  EditorPreset,
  type UpdateEditorPreference,
  UpdateEditorPreferenceSchema,
} from "proto-desktop-ts";
import { useId, useRef, useState } from "react";
import { sourceEditors } from "../../../../shared/source-editor";
import Select from "./Select";
import SettingCard from "./SettingCard";
import SettingRow from "./SettingRow";

const options = [
  { value: EditorPreset.SYSTEM, label: "系统默认" },
  { value: EditorPreset.CUSTOM, label: "自定义" },
  ...sourceEditors
    .filter(({ value }) => value !== EditorPreset.TEXTMATE)
    .map(({ value, label }) => ({ value, label })),
];

const commandFields = [
  { name: "openFile", label: "文件", example: "code %file" },
  { name: "openAtLine", label: "文件行", example: "code -g %file:%line" },
] as const;

const commandClass =
  "block w-full min-w-0 overflow-x-auto whitespace-pre rounded-lg border border-line " +
  "px-3 py-1.5 font-mono text-xs leading-[18px]";

export function SourceEditorSettings({
  value,
  onChange,
}: {
  value?: EditorPreference;
  onChange: (update: UpdateEditorPreference) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<CustomEditor>();
  const pendingSave = useRef(Promise.resolve());
  const commandId = useId();
  const saved = value?.selected ?? EditorPreset.SYSTEM;
  const selected = draft ? EditorPreset.CUSTOM : saved;
  const isCustom = selected === EditorPreset.CUSTOM;
  const preset = sourceEditors.find(({ value }) => value === selected);
  const commands = isCustom ? (draft ?? value?.custom) : preset;
  const validDraft =
    draft?.openFile.includes("%file") &&
    !draft.openFile.includes("%line") &&
    draft.openAtLine.includes("%file") &&
    draft.openAtLine.includes("%line");

  function save(choice: UpdateEditorPreference["choice"]) {
    pendingSave.current = pendingSave.current.then(async () => {
      const updated = await onChange(create(UpdateEditorPreferenceSchema, { choice }));
      if (updated && choice.case === "custom") {
        setDraft((current) => (current === choice.value ? undefined : current));
      }
    });
  }

  return (
    <SettingCard>
      <SettingRow title="编辑器">
        <Select
          ariaLabel="编辑器"
          options={options}
          value={selected}
          placeholder={preset?.label}
          menuPortal
          menuPlacement="top"
          menuMaxRows={6}
          focusFirstOption
          onChange={(next) => {
            if (next === selected) return;
            if (next === EditorPreset.CUSTOM) {
              const custom = value?.custom;
              setDraft(custom ?? create(CustomEditorSchema));
              if (custom) save({ case: "custom", value: custom });
            } else {
              setDraft(undefined);
              save({ case: "preset", value: next });
            }
          }}
        />
      </SettingRow>
      {commands && (
        <div className="space-y-2.5 px-5 py-3">
          {commandFields.map(({ name, label, example }) => (
            <div
              className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-3 text-[13px] text-ink"
              key={name}
            >
              {isCustom ? (
                <>
                  <label htmlFor={`${commandId}-${name}`}>{label}</label>
                  <input
                    id={`${commandId}-${name}`}
                    type="text"
                    className={`${commandClass} bg-surface outline-none focus:border-primary`}
                    value={commands[name]}
                    placeholder={example}
                    spellCheck={false}
                    onChange={(event) => {
                      setDraft(
                        create(CustomEditorSchema, { ...commands, [name]: event.target.value }),
                      );
                    }}
                    onBlur={() => {
                      if (draft && validDraft && draft !== value?.custom) {
                        save({ case: "custom", value: draft });
                      }
                    }}
                  />
                </>
              ) : (
                <>
                  <span>{label}</span>
                  <code
                    className={`${commandClass} cursor-default select-none bg-hover text-muted`}
                  >
                    {commands[name]}
                  </code>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </SettingCard>
  );
}
