import SettingCard from "./SettingCard";
import SettingRow from "./SettingRow";
import SettingsTabLayout from "./SettingsTabLayout";
import ShortcutInput, { type ShortcutValue } from "./ShortcutInput";
export type Shortcuts = Record<"search" | "chat" | "clipboard", ShortcutValue | null>;
const rows = [
  { id: "search", title: "全局搜索" },
  { id: "chat", title: "快速对话" },
  { id: "clipboard", title: "剪贴板" },
] as const;
export function ShortcutSettings({ values, onChange }: { values: Shortcuts; onChange: (value: Shortcuts) => void }) {
  function update(key: keyof Shortcuts, value: ShortcutValue | null) {
    const next = { ...values, [key]: value };
    if (value) {
      for (const { id } of rows) {
        if (id !== key && next[id]?.length === value.length && next[id]?.every((part) => value.includes(part))) {
          next[id] = null;
        }
      }
    }
    onChange(next);
  }
  return (
    <SettingsTabLayout title="快捷键">
      <SettingCard>
        {rows.map(({ id, title }) => (
          <SettingRow key={id} title={title}>
            <ShortcutInput
              value={values[id]}
              onChange={(value) => update(id, value)}
              placeholder={`录制${title}快捷键`}
            />
          </SettingRow>
        ))}
      </SettingCard>
    </SettingsTabLayout>
  );
}
