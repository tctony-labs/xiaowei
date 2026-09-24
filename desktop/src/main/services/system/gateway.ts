import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { create } from "@bufbuild/protobuf";
import { app, type BrowserWindow, clipboard, shell } from "electron";
import { EmptySchema, System } from "xiaowei-contracts";
import { bindHandlers } from "xiaowei-gateway";
import type { CallContext, GatewayHost } from "xiaowei-gateway/host";

function webUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 16384) throw new Error("Invalid URL");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported URL scheme");
  return url.href;
}

async function localPath(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Invalid local path");
  await access(path);
  return path;
}

export function registerSystem(host: GatewayHost, windowFor: (context: CallContext) => Pick<BrowserWindow, "hide">) {
  return host.registerOwner(
    "system",
    bindHandlers(
      System,
      {
        setAutostart(request) {
          const previous = app.getLoginItemSettings().openAtLogin;
          app.setLoginItemSettings({ openAtLogin: request.enabled });
          if (app.isPackaged && app.getLoginItemSettings().openAtLogin !== request.enabled) {
            app.setLoginItemSettings({ openAtLogin: previous });
            throw new Error("Unable to change login item setting");
          }
          return create(EmptySchema);
        },
        hideWindow(_request, _client, context) {
          windowFor(context).hide();
          if (process.platform === "darwin") app.hide();
          return create(EmptySchema);
        },
        writeClipboardText(request) {
          clipboard.writeText(request.text);
          return create(EmptySchema);
        },
        async openPath(request) {
          const error = await shell.openPath(await localPath(request.path));
          if (error) throw new Error(error);
          return create(EmptySchema);
        },
        async revealPath(request) {
          shell.showItemInFolder(await localPath(request.path));
          return create(EmptySchema);
        },
        async openUrl(request) {
          await shell.openExternal(webUrl(request.url));
          return create(EmptySchema);
        },
      },
      { partial: true },
    ),
  );
}
