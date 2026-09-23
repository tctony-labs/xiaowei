import { create, fromBinary } from "@bufbuild/protobuf";
import { useCallback, useEffect, useState } from "react";
import {
  EmptySchema,
  SettingsChangedSchema,
  type SettingsSnapshot,
  ShortcutBindingSchema,
  ShortcutConfigurationSchema,
  ThemeMode,
  type UpdateSettingsRequest,
  UpdateSettingsRequestSchema,
} from "xiaowei-contracts";
import type { Subscription } from "xiaowei-gateway";
import { services as defaultServices, type Services } from "../../services";
import { AboutSettings } from "./AboutSettings";
import { type CleanupStatus, ClipboardSettings } from "./ClipboardSettings";
import { GeneralSettings } from "./GeneralSettings";
import SettingsLayout, { type TabId } from "./SettingsLayout";
import { ShortcutSettings, type Shortcuts } from "./ShortcutSettings";

const tabs: TabId[] = ["general", "shortcut", "clipboard", "about"];

function themeValue(mode: ThemeMode): "system" | "light" | "dark" {
  if (mode === ThemeMode.LIGHT) return "light";
  if (mode === ThemeMode.DARK) return "dark";
  return "system";
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = themeValue(mode);
}

export function SettingsPage({
  version,
  development,
  services = defaultServices,
}: {
  version: string;
  development: boolean;
  services?: Services;
}) {
  const [tab, setTab] = useState<TabId>("general");
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [error, setError] = useState("");
  const [storageBytes, setStorageBytes] = useState<number>();
  const [refreshing, setRefreshing] = useState(false);
  const [cleanup, setCleanup] = useState<CleanupStatus>("idle");
  const api = services.getSettings();
  const clipboard = services.getClipboard();

  useEffect(() => {
    let active = true;
    let subscription: Subscription | undefined;
    let revision = 0;

    void (async () => {
      const handle = await services.getGateway().subscribe(SettingsChangedSchema.typeName, undefined, (bytes) => {
        const next = fromBinary(SettingsChangedSchema, bytes).snapshot;
        if (!active || !next) return;
        revision += 1;
        setSnapshot(next);
        applyTheme(next.theme);
      });
      if (!active) {
        handle.close();
        return;
      }
      subscription = handle;
      const before = revision;
      const current = await api.get(create(EmptySchema));
      if (active && revision === before) {
        setSnapshot(current);
        applyTheme(current.theme);
      }
    })().catch((cause: unknown) => {
      if (active) setError(`加载设置失败：${String(cause)}`);
    });

    return () => {
      active = false;
      subscription?.close();
    };
  }, [api, services]);

  async function update(change: UpdateSettingsRequest["change"]): Promise<void> {
    setError("");
    try {
      const next = await api.update(create(UpdateSettingsRequestSchema, { change }));
      setSnapshot(next);
      applyTheme(next.theme);
    } catch (cause) {
      setError(`保存失败：${String(cause)}`);
      try {
        setSnapshot(await api.get(create(EmptySchema)));
      } catch (reloadError) {
        console.error("Settings reload failed", reloadError);
      }
    }
  }

  const refreshStorage = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const result = await clipboard.storageUsage(create(EmptySchema));
      setStorageBytes(Number(result.usedBytes));
      setError("");
    } catch (cause) {
      setError(`读取存储空间失败：${String(cause)}`);
    } finally {
      setRefreshing(false);
    }
  }, [clipboard]);

  useEffect(() => {
    if (tab === "clipboard") void refreshStorage();
  }, [tab, refreshStorage]);

  async function cleanupOrdinary(): Promise<void> {
    setCleanup("cleaning");
    try {
      await clipboard.purgeOrdinary(create(EmptySchema));
      setCleanup("done");
      await refreshStorage();
    } catch (cause) {
      setCleanup("error");
      setError(`清理失败：${String(cause)}`);
    }
  }

  const shortcutBinding = (value: string[] | null) =>
    value ? create(ShortcutBindingSchema, { keys: value }) : undefined;
  const shortcuts: Shortcuts = {
    search: snapshot?.shortcuts?.main?.keys ?? null,
    chat: null,
    clipboard: snapshot?.shortcuts?.clipboard?.keys ?? null,
  };

  function page() {
    if (!snapshot) return null;
    switch (tab) {
      case "general":
        return (
          <GeneralSettings
            values={{
              theme: themeValue(snapshot.theme),
              autostart: snapshot.autostart,
              bookmarks: snapshot.includeChromeBookmarks,
            }}
            showAccount={false}
            onChange={(values) => {
              if (values.theme !== themeValue(snapshot.theme)) {
                const theme = { system: ThemeMode.SYSTEM, light: ThemeMode.LIGHT, dark: ThemeMode.DARK }[values.theme];
                void update({ case: "theme", value: theme });
              } else if (values.autostart !== snapshot.autostart) {
                void update({ case: "autostart", value: values.autostart });
              } else if (values.bookmarks !== snapshot.includeChromeBookmarks) {
                void update({ case: "includeChromeBookmarks", value: values.bookmarks });
              }
            }}
          />
        );
      case "shortcut":
        return (
          <ShortcutSettings
            values={shortcuts}
            showQuickChat={false}
            onChange={(next) =>
              void update({
                case: "shortcuts",
                value: create(ShortcutConfigurationSchema, {
                  main: shortcutBinding(next.search),
                  clipboard: shortcutBinding(next.clipboard),
                }),
              })
            }
          />
        );
      case "clipboard":
        return (
          <ClipboardSettings
            values={{
              enabled: snapshot.clipboardEnabled,
              autoPaste: snapshot.clipboardAutoPaste,
              retention: snapshot.clipboardRetentionDays,
            }}
            showImageExtraction={false}
            onChange={(values) => {
              if (values.enabled !== snapshot.clipboardEnabled) {
                void update({ case: "clipboardEnabled", value: values.enabled });
              } else if (values.autoPaste !== snapshot.clipboardAutoPaste) {
                void update({ case: "clipboardAutoPaste", value: values.autoPaste });
              } else if (values.retention !== snapshot.clipboardRetentionDays) {
                void update({ case: "clipboardRetentionDays", value: values.retention });
              }
            }}
            storageBytes={storageBytes}
            refreshing={refreshing}
            onRefresh={() => void refreshStorage()}
            cleanup={cleanup}
            onCleanup={() => void cleanupOrdinary()}
          />
        );
      case "about":
        return <AboutSettings version={version} development={development} showCheckUpdate={false} />;
      default:
        return null;
    }
  }

  return (
    <div className="relative h-screen w-screen">
      <div aria-hidden="true" className="settings-window-drag absolute inset-x-0 top-0 z-10 h-8" />
      <SettingsLayout activeTab={tab} onNavigate={setTab} availableTabs={tabs} loading={!snapshot && !error}>
        {page()}
      </SettingsLayout>
      {error && (
        <div
          role="alert"
          className="absolute bottom-4 left-1/2 z-30 max-w-[90%] -translate-x-1/2 rounded-lg bg-elevated px-4 py-2 text-sm text-danger shadow-lg"
        >
          {error}
          {!snapshot && (
            <button type="button" className="ml-3 text-primary-text" onClick={() => window.location.reload()}>
              重试
            </button>
          )}
        </div>
      )}
    </div>
  );
}
