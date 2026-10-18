import type { ReactNode } from "react";
import SegmentedControl from "./SegmentedControl";
import SettingCard from "./SettingCard";
import SettingRow from "./SettingRow";
import SettingsTabLayout from "./SettingsTabLayout";
import Toggle from "./Toggle";

export interface GeneralValues {
  theme: "system" | "light" | "dark";
  autostart: boolean;
  bookmarks: boolean;
}
export function GeneralSettings({
  values,
  accountSection,
  onChange,
}: {
  values: GeneralValues;
  accountSection?: ReactNode;
  onChange: (values: GeneralValues) => void;
}) {
  return (
    <SettingsTabLayout title="通用">
      {accountSection}
      <SettingCard>
        <SettingRow title="主题">
          <SegmentedControl
            value={values.theme}
            options={[
              { value: "system", label: "跟随系统" },
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
            onChange={(theme) => onChange({ ...values, theme })}
          />
        </SettingRow>
        <SettingRow title="开机自启动">
          <Toggle
            ariaLabel="开机自启动"
            checked={values.autostart}
            onChange={() => onChange({ ...values, autostart: !values.autostart })}
          />
        </SettingRow>
      </SettingCard>
      <SettingCard>
        <SettingRow title="全局搜索包含Chrome书签">
          <Toggle
            ariaLabel="全局搜索包含Chrome书签"
            checked={values.bookmarks}
            onChange={() => onChange({ ...values, bookmarks: !values.bookmarks })}
          />
        </SettingRow>
      </SettingCard>
    </SettingsTabLayout>
  );
}
