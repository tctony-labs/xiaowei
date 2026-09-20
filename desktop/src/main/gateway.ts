import { create } from "@bufbuild/protobuf";
import { BrowserWindow, ipcMain, protocol } from "electron";
import { App, ReadIconRequestSchema } from "xiaowei-contracts";
import { bindClient } from "xiaowei-gateway";
import { attachElectron } from "xiaowei-gateway/electron";
import { type CallContext, GatewayHost } from "xiaowei-gateway/host";
import { attachNative } from "xiaowei-gateway/native";
import { createSearchGatewayEndpoint } from "xiaowei-search";
import { registerClipboard } from "./clipboard";
import { createIconResources, ICON_SCHEME } from "./icon-resources";
import { type LauncherActions, registerSearch } from "./search";

export async function createApplicationGateway(directory: string, actions: Omit<LauncherActions, "iconUrl">) {
  const host = new GatewayHost();
  const electron = attachElectron(host, ipcMain);
  const windowFor = (context: CallContext) => {
    const window = BrowserWindow.fromWebContents(electron.target(context));
    if (!window || window.isDestroyed()) throw new Error("Window unavailable");
    return window;
  };
  let search: Awaited<ReturnType<typeof attachNative>> | undefined;
  let clipboard: Awaited<ReturnType<typeof registerClipboard>> | undefined;
  let launcher: ReturnType<typeof registerSearch>;
  const apps = bindClient(App, host.client({ caller: "icon-resources", trusted: true }));
  const icons = createIconResources(async (path) => (await apps.readIcon(create(ReadIconRequestSchema, { path }))).png);
  try {
    search = await attachNative(host, "search", createSearchGatewayEndpoint(actions.development));
    clipboard = await registerClipboard(host, directory);
    protocol.handle(ICON_SCHEME, (request) => icons.respond(request));
    launcher = registerSearch(host, windowFor, { ...actions, iconUrl: icons.url });
  } catch (error) {
    electron.close();
    protocol.unhandle(ICON_SCHEME);
    icons.close();
    await Promise.allSettled([clipboard?.close(), search?.close()]);
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
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
        const results = await Promise.allSettled([clipboard?.close(), search?.close()]);
        for (const result of results)
          if (result.status === "rejected") console.error("Gateway shutdown failed", result.reason);
      })();
      return closing;
    },
  };
}
