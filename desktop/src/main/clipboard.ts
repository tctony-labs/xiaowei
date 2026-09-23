import { mkdtempSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import { app, type BrowserWindow, clipboard, shell } from "electron";
import { ClipboardHistory, sendPasteShortcut } from "xiaowei-clipboard";
import {
  ClipboardBiz,
  ClipboardItemRequestSchema,
  ClipboardStorageUsageSchema,
  EmptySchema,
  PurgeExpiredRequestSchema,
  Settings,
  SettingsChangedSchema,
  System,
} from "xiaowei-contracts";
import { bindClient, bindHandlers, type Subscription } from "xiaowei-gateway";
import type { CallContext, GatewayHost } from "xiaowei-gateway/host";
import { attachNative } from "xiaowei-gateway/native";
import { clipboardPaths, clipboardPathText, webUrl } from "./clipboard-files";
import { clipboardStorageUsage } from "./clipboard-storage";

export async function registerClipboard(
  host: GatewayHost,
  directory: string,
  databasePath: string,
  windowFor: (context: CallContext) => Pick<BrowserWindow, "hide">,
) {
  const exportDirectory = mkdtempSync(join(app.getPath("temp"), "xiaowei-clipboard-"));
  // Legacy callback remains available to existing napi consumers; Gateway publishes from the same Service.
  let history: ClipboardHistory | undefined;
  let native: Awaited<ReturnType<typeof attachNative>> | undefined;
  let owner: ReturnType<GatewayHost["registerOwner"]> | undefined;
  let initialCleanup: NodeJS.Timeout | undefined;
  let cleanupInterval: NodeJS.Timeout | undefined;
  let subscription: Subscription | undefined;
  const settingsGateway = host.client({ caller: "clipboard-settings", trusted: true });
  const settings = bindClient(Settings, settingsGateway);
  const getSettings = () => settings.get(create(EmptySchema));
  try {
    history = await ClipboardHistory.open(directory, () => {});
    native = await attachNative(host, "clipboard", history.createGatewayEndpoint());
    await history.initialize();
    const content = history;
    const resolve = async (id: bigint, index?: number) => {
      if (id <= 0n || id > 0x7fffffffffffffffn) throw new Error("Invalid clipboard item ID");
      return clipboardPaths(content, exportDirectory, String(id), index);
    };
    const selectionClient = bindClient(ClipboardBiz, host.client({ caller: "clipboard-selection", trusted: true }));
    owner = host.registerOwner("clipboard-resources", [
      ...bindHandlers(
        System,
        {
          async openUrl(request) {
            await shell.openExternal(webUrl(request.url));
            return create(EmptySchema);
          },
        },
        { partial: true },
      ),
      ...bindHandlers(
        ClipboardBiz,
        {
          async select(request, _client, context) {
            if (request.id <= 0n || request.id > 0x7fffffffffffffffn) {
              throw new Error("Invalid clipboard item ID");
            }
            const window = windowFor(context);
            await selectionClient.copy(create(ClipboardItemRequestSchema, { id: request.id }));
            window.hide();
            if (process.platform === "darwin") app.hide();
            if (process.platform === "darwin" && (await getSettings()).clipboardAutoPaste) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              if (!sendPasteShortcut()) console.warn("Automatic paste needs Accessibility permission");
            }
            return create(EmptySchema);
          },
          async storageUsage() {
            return create(ClipboardStorageUsageSchema, {
              usedBytes: await clipboardStorageUsage(directory, databasePath),
            });
          },
          async openResource(request) {
            const paths = await resolve(request.id, request.index);
            if (paths.length !== 1) throw new Error("Select a single file to open");
            await access(paths[0]);
            const error = await shell.openPath(paths[0]);
            if (error) throw new Error(error);
            return create(EmptySchema);
          },
          async revealResource(request) {
            for (const path of await resolve(request.id, request.index)) {
              await access(path);
              shell.showItemInFolder(path);
            }
            return create(EmptySchema);
          },
          async copyResourcePath(request) {
            const paths = await resolve(request.id, request.index);
            clipboard.writeText(clipboardPathText(paths, request.directory));
            return create(EmptySchema);
          },
        },
        { partial: true },
      ),
    ]);
    if (process.platform === "darwin" && (await getSettings()).clipboardEnabled) {
      await history.startMonitoring();
    }
    const clipboardClient = bindClient(ClipboardBiz, host.client({ caller: "clipboard-cleanup", trusted: true }));
    const purgeExpired = async () => {
      try {
        const { clipboardRetentionDays } = await getSettings();
        if (clipboardRetentionDays === -1) return;
        await clipboardClient.purgeExpired(
          create(PurgeExpiredRequestSchema, {
            retentionDays: clipboardRetentionDays,
          }),
        );
      } catch (error) {
        console.error("Clipboard retention cleanup failed", error);
      }
    };
    let retention = (await getSettings()).clipboardRetentionDays;
    subscription = await settingsGateway.subscribe(SettingsChangedSchema.typeName, undefined, (bytes) => {
      const values = fromBinary(SettingsChangedSchema, bytes).snapshot;
      if (!values) return;
      if (values.clipboardRetentionDays === retention) return;
      retention = values.clipboardRetentionDays;
      void purgeExpired();
    });
    initialCleanup = setTimeout(() => {
      void purgeExpired();
      cleanupInterval = setInterval(() => void purgeExpired(), 60 * 60 * 1000);
      cleanupInterval.unref();
    }, 30_000);
    initialCleanup.unref();
    console.info("Clipboard history ready");
  } catch (error) {
    subscription?.close();
    clearTimeout(initialCleanup);
    clearInterval(cleanupInterval);
    await history?.stopMonitoring();
    owner?.close();
    try {
      await native?.close();
    } finally {
      rmSync(exportDirectory, { recursive: true, force: true });
    }
    throw error;
  }
  return {
    async setMonitoring(enabled: boolean) {
      if (process.platform !== "darwin") return;
      if (enabled) await history?.startMonitoring();
      else await history?.stopMonitoring();
    },
    async close() {
      subscription?.close();
      clearTimeout(initialCleanup);
      clearInterval(cleanupInterval);
      await history?.stopMonitoring();
      owner?.close();
      try {
        await native?.close();
      } finally {
        rmSync(exportDirectory, { recursive: true, force: true });
      }
    },
  };
}
