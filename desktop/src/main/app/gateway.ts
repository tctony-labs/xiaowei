import { create } from "@bufbuild/protobuf";
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import { ClipboardHistory } from "xiaowei-clipboard";
import { App, EmptySchema, ReadIconRequestSchema, Settings } from "xiaowei-contracts";
import { bindClient } from "xiaowei-gateway";
import { attachElectron } from "xiaowei-gateway/electron";
import { type CallContext, GatewayHost } from "xiaowei-gateway/host";
import { attachNative } from "xiaowei-gateway/native";
import { createSearchGatewayEndpoint } from "xiaowei-search";
import { Storage } from "xiaowei-storage";
import { createAppIconCache } from "../resources/app-icons/cache";
import { createIconResources, ICON_SCHEME } from "../resources/app-icons/protocol";
import { type LauncherActions, registerSearch } from "../services/launcher/gateway";
import { attachLlm } from "../services/llm/host";
import type { ModelConfig } from "../services/llm/provider";
import { registerShortcuts } from "../services/shortcuts/gateway";
import type { ShortcutConfig } from "../services/shortcuts/shortcuts";
import { registerSystem } from "../services/system/gateway";

export async function createApplicationGateway(
  directory: string,
  databasePath: string,
  iconDirectory: string,
  actions: Omit<LauncherActions, "iconUrl" | "includeChromeBookmarks"> & {
    updateShortcuts(shortcuts: ShortcutConfig): void;
  },
  models: readonly ModelConfig[] = [],
) {
  const host = new GatewayHost();
  const electron = attachElectron(host, ipcMain);
  const windowFor = (context: CallContext) => {
    const window = BrowserWindow.fromWebContents(electron.target(context));
    if (!window || window.isDestroyed()) throw new Error("Window unavailable");
    return window;
  };
  let llm: Awaited<ReturnType<typeof attachLlm>> | undefined;
  let shortcuts: ReturnType<typeof registerShortcuts> | undefined;
  let system: ReturnType<typeof registerSystem> | undefined;
  let storage: Awaited<ReturnType<typeof attachNative>> | undefined;
  let clipboardDao: Awaited<ReturnType<typeof attachNative>> | undefined;
  let search: Awaited<ReturnType<typeof attachNative>> | undefined;
  let clipboard: Awaited<ReturnType<typeof attachNative>> | undefined;
  let history: ClipboardHistory | undefined;
  let launcher: ReturnType<typeof registerSearch>;
  let settings: Awaited<ReturnType<typeof attachNative>> | undefined;
  const settingsApi = bindClient(Settings, host.client({ caller: "settings-main", trusted: true }));
  const apps = bindClient(App, host.client({ caller: "icon-resources", trusted: true }));
  const readIcon = createAppIconCache(iconDirectory, async (path) => {
    const { png } = await apps.readIcon(create(ReadIconRequestSchema, { path }));
    return png ? Buffer.from(png) : null;
  });
  const icons = createIconResources(async (path) => (await readIcon(path)) ?? undefined);
  async function closeClipboard() {
    try {
      await history?.stopServices();
    } finally {
      try {
        await clipboard?.close();
      } finally {
        await history?.close();
      }
    }
  }
  let iconProtocolHandled = false;
  try {
    llm = await attachLlm(host, models);
    system = registerSystem(host, windowFor);
    shortcuts = registerShortcuts(host, actions.updateShortcuts);
    const database = await Storage.open(databasePath);
    storage = await attachNative(host, "storage", database.createKeyValueGatewayEndpoint());
    clipboardDao = await attachNative(host, "clipboard-dao", database.createClipboardDaoGatewayEndpoint());
    settings = await attachNative(host, "settings", database.createSettingsGatewayEndpoint(actions.platform));
    search = await attachNative(host, "search", createSearchGatewayEndpoint(actions.development));
    history = await ClipboardHistory.open(directory, () => {}, app.getPath("temp"));
    clipboard = await attachNative(host, "clipboard", history.createGatewayEndpoint());
    await history.initialize();
    await history.startServices();
    console.info("Clipboard history ready");
    protocol.handle(ICON_SCHEME, (request) => icons.respond(request));
    iconProtocolHandled = true;
    launcher = registerSearch(host, windowFor, {
      ...actions,
      iconUrl: icons.url,
      includeChromeBookmarks: async () => (await settingsApi.get(create(EmptySchema))).includeChromeBookmarks,
    });
  } catch (error) {
    electron.close();
    if (iconProtocolHandled) protocol.unhandle(ICON_SCHEME);
    icons.close();
    await Promise.allSettled([closeClipboard(), search?.close(), llm?.close()]);
    shortcuts?.close();
    system?.close();
    await settings?.close();
    await clipboardDao?.close();
    await storage?.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    settings: settingsApi,
    register(window: BrowserWindow) {
      electron.register(window.webContents);
    },
    opened: launcher.opened,
    close() {
      closing ??= (async () => {
        electron.close();
        protocol.unhandle(ICON_SCHEME);
        icons.close();
        launcher.close();
        const results = await Promise.allSettled([closeClipboard(), search?.close(), llm?.close()]);
        shortcuts?.close();
        system?.close();
        await settings?.close();
        await clipboardDao?.close();
        await storage?.close();
        for (const result of results)
          if (result.status === "rejected") console.error("Gateway shutdown failed", result.reason);
      })();
      return closing;
    },
  };
}
